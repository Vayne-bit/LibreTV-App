// ============ 音乐离线下载 ============
// 曲目 blob 存 IndexedDB（libretvMusicDownloads/tracks，key=platform|id），
// 与视频离线下载相互独立。播放时优先命中离线库（见 music_player.js）。
// 导出文件用 a[download]（桌面 WebView 支持；车机不支持时仅保存在库内离线可听）。

const MUSIC_DL_DB = 'libretvMusicDownloads';
const MUSIC_DL_STORE = 'tracks';
const MUSIC_DL_LIMIT_BYTES = 5 * 1000 * 1000 * 1000; // 5GB
const MUSIC_DL_CONCURRENCY = 2;
const MUSIC_DL_MAX_BYTES = 200 * 1000 * 1000; // 单曲上限（无损一般 <100MB）

let musicDlDb = null;
let musicDlDbPromise = null;
const musicDlTasks = new Map(); // key -> { status, received, total, error, item }
const musicDlListeners = new Set();

function musicDlOpen() {
    if (musicDlDb) return Promise.resolve(musicDlDb);
    if (musicDlDbPromise) return musicDlDbPromise;
    musicDlDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(MUSIC_DL_DB, 1);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(MUSIC_DL_STORE)) {
                db.createObjectStore(MUSIC_DL_STORE, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => {
            musicDlDb = request.result;
            musicDlDb.onversionchange = () => {
                try { musicDlDb.close(); } catch (e) { /* 已关闭 */ }
                musicDlDb = null; musicDlDbPromise = null;
            };
            resolve(musicDlDb);
        };
        request.onerror = () => { musicDlDbPromise = null; reject(request.error || new Error('打开音乐库失败')); };
        request.onblocked = () => { musicDlDbPromise = null; reject(new Error('音乐库被其它页面占用')); };
    });
    return musicDlDbPromise;
}

function musicDlPut(record) {
    return musicDlOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(MUSIC_DL_STORE, 'readwrite');
        tx.objectStore(MUSIC_DL_STORE).put(record);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('写入失败'));
    }));
}

function musicDlGet(key) {
    return musicDlOpen().then(db => new Promise((resolve, reject) => {
        const req = db.transaction(MUSIC_DL_STORE, 'readonly').objectStore(MUSIC_DL_STORE).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error || new Error('读取失败'));
    })).catch(() => null);
}

function musicDlGetBlob(key) {
    return musicDlGet(key).then(record => (record && record.blob) ? { blob: record.blob, meta: record } : null);
}

function musicDlList() {
    return musicDlOpen().then(db => new Promise((resolve, reject) => {
        const req = db.transaction(MUSIC_DL_STORE, 'readonly').objectStore(MUSIC_DL_STORE).getAll();
        req.onsuccess = () => {
            const rows = (req.result || []).sort((a, b) => (b.at || 0) - (a.at || 0));
            resolve(rows);
        };
        req.onerror = () => reject(req.error || new Error('读取失败'));
    })).catch(() => []);
}

function musicDlDelete(key) {
    return musicDlOpen().then(db => new Promise((resolve, reject) => {
        const tx = db.transaction(MUSIC_DL_STORE, 'readwrite');
        tx.objectStore(MUSIC_DL_STORE).delete(key);
        tx.oncomplete = () => resolve(true);
        tx.onerror = () => reject(tx.error || new Error('删除失败'));
    })).catch(() => false);
}

function musicDlNotify() {
    musicDlListeners.forEach(listener => { try { listener(); } catch (e) { /* 忽略 */ } });
}

function onMusicDlChange(listener) {
    if (typeof listener === 'function') musicDlListeners.add(listener);
    return () => musicDlListeners.delete(listener);
}

// 并发限流队列：MUSIC_DL_CONCURRENCY 此前声明了从未实现——多曲连点会
// 互相抢带宽拖慢全部。现在排队执行，同时最多 2 首在传。
const musicDlQueue = [];
let musicDlActive = 0;

// 下载一首：解析地址 -> 带进度取回 blob -> 入库（经队列限流）
function musicDownloadTrack(item) {
    return new Promise(resolve => {
        musicDlQueue.push({ item, resolve });
        musicDlPump();
    });
}

function musicDlPump() {
    while (musicDlActive < MUSIC_DL_CONCURRENCY && musicDlQueue.length) {
        const job = musicDlQueue.shift();
        musicDlActive++;
        musicDownloadTrackRun(job.item)
            .catch(e => ({ ok: false, reason: (e && e.message) || '下载失败' }))
            .then(result => {
                musicDlActive--;
                job.resolve(result);
                musicDlPump();
            });
    }
}

async function musicDownloadTrackRun(item) {
    const key = musicKey(item);
    const running = musicDlTasks.get(key);
    if (running && (running.status === 'downloading')) return { ok: false, reason: '该曲目正在下载' };
    const existing = await musicDlGet(key);
    if (existing && existing.blob) return { ok: false, reason: '该曲目已下载' };

    let source;
    try {
        source = await MusicPlugin.resolveMusicSource(item, 'high');
    } catch (e) {
        return { ok: false, reason: (e && e.message) || '解析失败' };
    }
    if (!source || !source.url) return { ok: false, reason: '暂无可用音源（付费内容或源未提供）' };

    // cancelled 标志：下载中用户删除该曲目时置位——入库前检查，否则删除后
    // 任务完成又把记录写回来（视频侧 player_download 的 cancelEpisodeDownload
    // 已正确处理，音乐侧此前漏掉了这层）
    const task = { status: 'downloading', received: 0, total: 0, error: '', item, cancelled: false };
    musicDlTasks.set(key, task);
    musicDlNotify();
    let blob = null;
    try {
        // WebView fetch 直取。实测（2026-11-05）：酷狗 sharefs 签名直链无 UA/Referer
        // 要求（206 + audio/mpeg），<audio>/<fetch> 均可直接访问；
        // 需要自定义请求头的源在 fetch 失败时如实报错。
        // （Rust 的 make_http_request 以文本读响应，二进制会损坏，不能做下载通道。）
        const resp = await fetch(source.url, {
            headers: (source.headers && Object.keys(source.headers).length) ? source.headers : undefined
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const declared = Number(resp.headers.get('content-length')) || 0;
        if (declared > MUSIC_DL_MAX_BYTES) throw new Error('文件超过单曲上限 ' + formatMusicBytes(MUSIC_DL_MAX_BYTES));
        if (resp.body && typeof resp.body.getReader === 'function') {
            const reader = resp.body.getReader();
            const chunks = [];
            let received = 0;
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                chunks.push(value);
                received += value.length;
                task.received = received;
                task.total = declared || 0;
                if (received > MUSIC_DL_MAX_BYTES) throw new Error('文件超过单曲上限');
                if (Math.random() < 0.02) musicDlNotify(); // 低频刷新进度
            }
            blob = new Blob(chunks, { type: resp.headers.get('content-type') || 'audio/mpeg' });
        } else {
            blob = await resp.blob();
        }
        if (!blob || !blob.size) throw new Error('文件内容为空');
        if (task.cancelled) return { ok: false, reason: '该曲目已删除，下载已取消' };
        const ext = (/(\.\w{2,5})(?:\?|$)/.exec(source.url) || [])[1] || '.mp3';
        await musicDlPut({
            key,
            item: {
                platform: item.platform, id: item.id, title: item.title, artist: item.artist,
                album: item.album || '', artwork: item.artwork || '', duration: item.duration || 0
            },
            blob, size: blob.size, ext, at: Date.now(),
            sourceUrl: source.url
        });
        task.status = 'done';
        musicDlNotify();
        return { ok: true };
    } catch (e) {
        task.status = 'failed';
        task.error = (e && e.message) || '下载失败';
        musicDlNotify();
        return { ok: false, reason: task.error };
    } finally {
        setTimeout(() => { if (musicDlTasks.get(key) === task && task.status !== 'downloading') musicDlTasks.delete(key); }, 5000);
    }
}

function musicDlTaskFor(item) {
    return musicDlTasks.get(musicKey(item)) || null;
}

// 导出为本地文件（桌面 WebView 支持 a[download]）
function musicDlExport(key) {
    return musicDlGet(key).then(record => {
        if (!record || !record.blob) return false;
        const name = ((record.item && record.item.title) || 'track').replace(/[\\/:*?"<>|]/g, '_') + (record.ext || '.mp3');
        const url = URL.createObjectURL(record.blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return true;
    });
}

// 库容量：超限时按时间删最旧的
async function musicDlEnforceLimit() {
    const rows = await musicDlList();
    let total = rows.reduce((sum, row) => sum + (row.size || 0), 0);
    if (total <= MUSIC_DL_LIMIT_BYTES) return;
    for (const row of rows) {
        if (total <= MUSIC_DL_LIMIT_BYTES) break;
        if (await musicDlDelete(row.key)) total -= row.size || 0;
    }
}
