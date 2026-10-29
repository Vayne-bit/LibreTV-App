// 整集离线下载：把一集的全部分片抓进独立的 IndexedDB，播放时由 loader 直接命中，不再走网络
// 与分片缓存分开存放：缓存是可随时丢弃的临时数据，下载是用户主动要的文件，清缓存不能连带删掉

const DOWNLOAD_DB = 'libretvDownloads';
const DOWNLOAD_VERSION = 1;
const DOWNLOAD_SEGMENT_STORE = 'segments';
const DOWNLOAD_EPISODE_STORE = 'episodes';
// 采集站 1080p 单集常见 500~800MB，20GB 大概能放 25~40 集
const DOWNLOAD_LIMIT_BYTES = 20 * 1000 * 1000 * 1000;
const DOWNLOAD_EPISODE_CONCURRENCY = 2;
const DOWNLOAD_SEGMENT_CONCURRENCY = 4;
const DOWNLOAD_SEGMENT_MAX_BYTES = 64 * 1000 * 1000;
const DOWNLOAD_NOTIFY_MS = 150;

let downloadDb = null;
let downloadDbPromise = null;
let downloadNotifyTimer = null;
let downloadActiveCount = 0;
let downloadDoneKeys = new Set();
const downloadTasks = new Map();
const downloadQueue = [];
const downloadListeners = new Set();

function isDownloadSupported() {
    return typeof indexedDB !== 'undefined' && !!indexedDB;
}

function openDownloadDb() {
    if (!isDownloadSupported()) return Promise.reject(new Error('当前环境不支持 IndexedDB'));
    if (downloadDb) return Promise.resolve(downloadDb);
    if (downloadDbPromise) return downloadDbPromise;
    downloadDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DOWNLOAD_DB, DOWNLOAD_VERSION);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(DOWNLOAD_SEGMENT_STORE)) {
                db.createObjectStore(DOWNLOAD_SEGMENT_STORE, { keyPath: 'key' });
            }
            if (!db.objectStoreNames.contains(DOWNLOAD_EPISODE_STORE)) {
                db.createObjectStore(DOWNLOAD_EPISODE_STORE, { keyPath: 'key' });
            }
        };
        request.onsuccess = () => {
            downloadDb = request.result;
            // 别的标签页要升级版本时让出连接，否则会一直卡住对方
            downloadDb.onversionchange = () => {
                try { downloadDb.close(); } catch (e) { /* 已关闭 */ }
                downloadDb = null;
                downloadDbPromise = null;
            };
            resolve(downloadDb);
        };
        request.onerror = () => {
            downloadDbPromise = null;
            reject(request.error || new Error('打开下载库失败'));
        };
        request.onblocked = () => {
            downloadDbPromise = null;
            reject(new Error('下载库被其他标签页占用'));
        };
    });
    return downloadDbPromise;
}

function downloadEpisodeKey(title, index) {
    return `${String(title || '')}||${Number(index) || 0}`;
}

// 与 segmentCacheKey 保持一致，播放时 loader 才能用同一个 key 命中
function downloadSegmentKey(url, rangeStart, rangeEnd) {
    const start = Number(rangeStart) || 0;
    const end = Number(rangeEnd) || 0;
    return start || end ? `${url}#${start}-${end}` : String(url || '');
}

function resolveDownloadUrl(relative, base) {
    try {
        return new URL(relative, base).href;
    } catch (e) {
        return String(relative || '');
    }
}

function downloadSegmentGet(key) {
    if (!isDownloadSupported() || !key) return Promise.resolve(null);
    return openDownloadDb().then(db => new Promise(resolve => {
        let request;
        try {
            request = db.transaction(DOWNLOAD_SEGMENT_STORE, 'readonly').objectStore(DOWNLOAD_SEGMENT_STORE).get(key);
        } catch (e) {
            resolve(null);
            return;
        }
        request.onsuccess = () => {
            const record = request.result;
            resolve(record && record.data ? record : null);
        };
        request.onerror = () => resolve(null);
    })).catch(() => null);
}

function downloadSegmentPut(key, buffer, url) {
    if (!isDownloadSupported() || !key || !buffer) return Promise.resolve(false);
    return openDownloadDb().then(db => new Promise(resolve => {
        let request;
        try {
            request = db.transaction(DOWNLOAD_SEGMENT_STORE, 'readwrite').objectStore(DOWNLOAD_SEGMENT_STORE)
                .put({ key, url: String(url || ''), data: buffer, size: buffer.byteLength || 0, at: Date.now() });
        } catch (e) {
            resolve(false);
            return;
        }
        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(false);
    })).catch(() => false);
}

function downloadEpisodeGet(key) {
    if (!isDownloadSupported() || !key) return Promise.resolve(null);
    return openDownloadDb().then(db => new Promise(resolve => {
        let request;
        try {
            request = db.transaction(DOWNLOAD_EPISODE_STORE, 'readonly').objectStore(DOWNLOAD_EPISODE_STORE).get(key);
        } catch (e) {
            resolve(null);
            return;
        }
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => resolve(null);
    })).catch(() => null);
}

function downloadEpisodePut(record) {
    if (!isDownloadSupported() || !record || !record.key) return Promise.resolve(false);
    return openDownloadDb().then(db => new Promise(resolve => {
        let request;
        try {
            request = db.transaction(DOWNLOAD_EPISODE_STORE, 'readwrite').objectStore(DOWNLOAD_EPISODE_STORE).put(record);
        } catch (e) {
            resolve(false);
            return;
        }
        request.onsuccess = () => resolve(true);
        request.onerror = () => resolve(false);
    })).catch(() => false);
}

function listDownloadedEpisodes() {
    if (!isDownloadSupported()) return Promise.resolve([]);
    return openDownloadDb().then(db => new Promise(resolve => {
        let request;
        try {
            request = db.transaction(DOWNLOAD_EPISODE_STORE, 'readonly').objectStore(DOWNLOAD_EPISODE_STORE).getAll();
        } catch (e) {
            resolve([]);
            return;
        }
        request.onsuccess = () => {
            const rows = Array.isArray(request.result) ? request.result : [];
            rows.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
            resolve(rows);
        };
        request.onerror = () => resolve([]);
    })).catch(() => []);
}

// 分片可能被多个下载任务共用（同一集重下），所以按 key 计数而不是直接删
function deleteEpisodeSegments(segmentKeys) {
    if (!isDownloadSupported() || !segmentKeys || !segmentKeys.length) return Promise.resolve(0);
    return openDownloadDb().then(db => new Promise(resolve => {
        let removed = 0;
        const transaction = db.transaction(DOWNLOAD_SEGMENT_STORE, 'readwrite');
        const store = transaction.objectStore(DOWNLOAD_SEGMENT_STORE);
        segmentKeys.forEach(key => {
            const request = store.delete(key);
            request.onsuccess = () => { removed += 1; };
        });
        transaction.oncomplete = () => resolve(removed);
        transaction.onerror = () => resolve(removed);
    })).catch(() => 0);
}

function deleteEpisodeDownload(key) {
    return downloadEpisodeGet(key).then(record => {
        if (!record) return false;
        return deleteEpisodeSegments(record.segmentKeys || [])
            .then(() => openDownloadDb())
            .then(db => new Promise(resolve => {
                const transaction = db.transaction(DOWNLOAD_EPISODE_STORE, 'readwrite');
                transaction.objectStore(DOWNLOAD_EPISODE_STORE).delete(key);
                transaction.oncomplete = () => resolve(true);
                transaction.onerror = () => resolve(false);
            }))
            .catch(() => false);
    }).catch(() => false);
}

// 下载管理页的多选删除：串行删，避免同时开一堆事务把车机 IO 打死
function deleteDownloadedEpisodes(keys) {
    const list = Array.isArray(keys) ? keys.slice() : [];
    if (!list.length) return Promise.resolve(0);
    return list.reduce((chain, key) => chain.then(removed => {
        downloadTasks.delete(key);
        return deleteEpisodeDownload(key).then(ok => removed + (ok ? 1 : 0));
    }), Promise.resolve(0)).then(removed => {
        return refreshDownloadedKeys().then(() => {
            notifyDownloadListeners();
            return removed;
        });
    }).catch(() => 0);
}

// 下载只在进行中的页面里跑，切走页面任务就没了。
// 库里残留的 downloading / queued 记录已经不可能继续，标成中断，避免管理页一直显示「下载中」
function markStaleDownloads() {
    return listDownloadedEpisodes().then(rows => {
        const stale = rows.filter(record =>
            (record.status === 'downloading' || record.status === 'queued') && !downloadTasks.has(record.key));
        if (!stale.length) return 0;
        return stale.reduce((chain, record) => chain.then(() => {
            record.status = 'failed';
            record.error = '下载已中断';
            record.updatedAt = Date.now();
            return downloadEpisodePut(record);
        }), Promise.resolve()).then(() => stale.length);
    }).catch(() => 0);
}

function notifyDownloadListeners() {
    if (downloadNotifyTimer) return;
    downloadNotifyTimer = setTimeout(() => {
        downloadNotifyTimer = null;
        const snapshot = downloadSnapshot();
        downloadListeners.forEach(listener => {
            try { listener(snapshot); } catch (e) { /* 单个订阅者出错不影响其它 */ }
        });
    }, DOWNLOAD_NOTIFY_MS);
}

function onDownloadChange(listener) {
    if (typeof listener === 'function') downloadListeners.add(listener);
    return () => downloadListeners.delete(listener);
}

// 剧集列表要判断「哪几集已经下好了」，每次刷新只读一次库，结果缓存在内存里
function refreshDownloadedKeys() {
    return listDownloadedEpisodes().then(rows => {
        downloadDoneKeys = new Set(rows.filter(record => record.status === 'done').map(record => record.key));
        return downloadDoneKeys;
    }).catch(() => downloadDoneKeys);
}

function isEpisodeDownloaded(title, index) {
    return downloadDoneKeys.has(downloadEpisodeKey(title, index));
}

function downloadSnapshot() {
    return Array.from(downloadTasks.values()).map(task => ({
        key: task.key, title: task.title, index: task.index, label: task.label,
        status: task.status, done: task.done, total: task.total, bytes: task.bytes, error: task.error || ''
    }));
}

function downloadTaskFor(key) {
    return downloadTasks.get(key) || null;
}

function fetchDownloadText(url) {
    return fetch(url, { credentials: 'omit' }).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.text();
    });
}

// master playlist 里挑一路：优先码率最低的那路，下载体积最可控
function pickVariantUrl(text, baseUrl) {
    const lines = String(text || '').split('\n');
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
        const bandwidth = /BANDWIDTH=(\d+)/.exec(line);
        const next = (lines[i + 1] || '').trim();
        if (!next || next.startsWith('#')) continue;
        variants.push({ url: resolveDownloadUrl(next, baseUrl), bandwidth: bandwidth ? Number(bandwidth[1]) : 0 });
    }
    if (!variants.length) return '';
    variants.sort((a, b) => a.bandwidth - b.bandwidth);
    return variants[0].url;
}

function resolveMediaPlaylist(url) {
    return fetchDownloadText(url).then(text => {
        if (String(text).indexOf('#EXT-X-STREAM-INF') < 0) return { text, url };
        const variant = pickVariantUrl(text, url);
        if (!variant) throw new Error('播放列表里没有可用的清晰度');
        return fetchDownloadText(variant).then(variantText => ({ text: variantText, url: variant }));
    });
}

function parsePlaylistSegments(text, baseUrl) {
    const lines = String(text || '').split('\n');
    const segments = [];
    let duration = 0;
    let pendingRange = null;
    let mapUrl = '';
    let encrypted = false;
    let previousEnd = 0;
    lines.forEach(raw => {
        const line = raw.trim();
        if (!line) return;
        if (line.indexOf('#EXT-X-MAP:') === 0) {
            const uri = /URI="([^"]+)"/.exec(line);
            if (uri) mapUrl = resolveDownloadUrl(uri[1], baseUrl);
            return;
        }
        if (line.indexOf('#EXT-X-KEY:') === 0) {
            if (line.indexOf('METHOD=NONE') < 0) encrypted = true;
            return;
        }
        if (line.indexOf('#EXTINF:') === 0) {
            const value = parseFloat(line.slice(8).split(',')[0]);
            duration = Number.isFinite(value) ? value : 0;
            return;
        }
        if (line.indexOf('#EXT-X-BYTERANGE:') === 0) {
            const parts = line.slice(17).split('@');
            const length = Number(parts[0]) || 0;
            // 省略 offset 表示「紧接上一段」，要自己累计
            const offset = parts.length > 1 ? Number(parts[1]) || 0 : previousEnd;
            pendingRange = length > 0 ? { start: offset, end: offset + length - 1 } : null;
            previousEnd = pendingRange ? pendingRange.end + 1 : previousEnd;
            return;
        }
        if (line.charAt(0) === '#') return;
        const segmentUrl = resolveDownloadUrl(line, baseUrl);
        segments.push({
            url: segmentUrl,
            duration,
            rangeStart: pendingRange ? pendingRange.start : 0,
            rangeEnd: pendingRange ? pendingRange.end : 0,
            key: downloadSegmentKey(segmentUrl, pendingRange ? pendingRange.start : 0, pendingRange ? pendingRange.end : 0)
        });
        duration = 0;
        pendingRange = null;
    });
    return { segments, mapUrl, encrypted };
}

function fetchSegmentBuffer(segment, signal) {
    const options = { credentials: 'omit', signal };
    if (segment.rangeStart || segment.rangeEnd) {
        options.headers = { Range: `bytes=${segment.rangeStart}-${segment.rangeEnd}` };
    }
    return fetch(segment.url, options).then(response => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
    }).then(buffer => {
        if (!buffer || !buffer.byteLength) throw new Error('空分片');
        if (buffer.byteLength > DOWNLOAD_SEGMENT_MAX_BYTES) throw new Error('分片过大');
        return buffer;
    });
}

function runWithConcurrency(items, limit, worker) {
    let cursor = 0;
    const runners = [];
    const size = Math.min(limit, items.length);
    for (let i = 0; i < size; i++) {
        runners.push((async () => {
            while (cursor < items.length) {
                const item = items[cursor];
                cursor += 1;
                await worker(item);
            }
        })());
    }
    return Promise.all(runners);
}

function checkDownloadQuota(extraBytes) {
    if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.estimate) {
        return Promise.resolve({ ok: true });
    }
    return navigator.storage.estimate().then(info => {
        const usage = (info && info.usage) || 0;
        const quota = (info && info.quota) || 0;
        if (usage + (extraBytes || 0) > DOWNLOAD_LIMIT_BYTES) {
            return { ok: false, reason: '下载空间已满，先在播放页删掉一些已下载的集数' };
        }
        // 浏览器给的配额可能比我们设的上限还小，留 200MB 余量
        if (quota && usage + (extraBytes || 0) > quota - 200 * 1000 * 1000) {
            return { ok: false, reason: '设备剩余空间不足' };
        }
        return { ok: true };
    }).catch(() => ({ ok: true }));
}

function applyDownloadPlaylistFilter(text, url) {
    if (typeof filterAdsFromM3U8 !== 'function') return text;
    try {
        return filterAdsFromM3U8(text, true, url);
    } catch (e) {
        return text;
    }
}

async function runDownloadTask(task) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    task.controller = controller;
    task.status = 'downloading';
    task.error = '';
    notifyDownloadListeners();
    try {
        const media = await resolveMediaPlaylist(task.url);
        if (task.cancelled) throw new Error('已取消');
        const filtered = applyDownloadPlaylistFilter(media.text, media.url);
        const parsed = parsePlaylistSegments(filtered, media.url);
        if (!parsed.segments.length) throw new Error('播放列表里没有分片');
        if (parsed.encrypted) throw new Error('加密片源暂不支持下载');

        const record = {
            key: task.key, title: task.title, index: task.index, label: task.label,
            url: task.url, playlistUrl: media.url, status: 'downloading',
            episodes: task.episodes || [task.url],
            episodeNames: task.episodeNames || [],
            cover: task.cover || '',
            sourceName: task.sourceName || '',
            sourceCode: task.sourceCode || '',
            info: task.info || null,
            segmentKeys: parsed.segments.map(segment => segment.key),
            total: parsed.segments.length, done: 0, bytes: 0,
            createdAt: Date.now(), updatedAt: Date.now()
        };
        task.total = parsed.segments.length;
        await downloadEpisodePut(record);

        const quota = await checkDownloadQuota(0);
        if (!quota.ok) throw new Error(quota.reason);

        const tasks = [];
        if (parsed.mapUrl) {
            tasks.push({ url: parsed.mapUrl, rangeStart: 0, rangeEnd: 0, key: downloadSegmentKey(parsed.mapUrl, 0, 0) });
        }
        parsed.segments.forEach(segment => tasks.push(segment));

        const total = tasks.length;
        task.total = total;

        await runWithConcurrency(tasks, DOWNLOAD_SEGMENT_CONCURRENCY, async segment => {
            if (task.cancelled) return;
            // 之前下过一半的集数可以续传，已经落盘的分片不再重复请求
            const existing = await downloadSegmentGet(segment.key);
            if (existing) {
                task.done += 1;
                task.bytes += existing.size || 0;
                notifyDownloadListeners();
                return;
            }
            let lastError = null;
            for (let attempt = 0; attempt < 3; attempt++) {
                if (task.cancelled) return;
                try {
                    const buffer = await fetchSegmentBuffer(segment, controller ? controller.signal : undefined);
                    await downloadSegmentPut(segment.key, buffer, segment.url);
                    task.done += 1;
                    task.bytes += buffer.byteLength;
                    notifyDownloadListeners();
                    return;
                } catch (error) {
                    if (task.cancelled) return;
                    lastError = error;
                }
            }
            throw lastError || new Error('分片下载失败');
        });

        if (task.cancelled) throw new Error('已取消');
        record.status = 'done';
        record.done = total;
        record.bytes = task.bytes;
        record.updatedAt = Date.now();
        await downloadEpisodePut(record);
        task.status = 'done';
        await enforceDownloadLimit();
    } catch (error) {
        task.error = (error && error.message) || '下载失败';
        task.status = task.cancelled ? 'cancelled' : 'failed';
        await downloadEpisodeGet(task.key).then(record => {
            if (!record) return null;
            record.status = task.status;
            record.done = task.done;
            record.bytes = task.bytes;
            record.updatedAt = Date.now();
            return downloadEpisodePut(record);
        });
    } finally {
        task.controller = null;
        notifyDownloadListeners();
        refreshDownloadedKeys().then(() => notifyDownloadListeners());
    }
}

// 超上限时按最后更新时间删最旧的已完成集数
function enforceDownloadLimit() {
    return listDownloadedEpisodes().then(records => {
        const done = records.filter(record => record.status === 'done');
        let total = done.reduce((sum, record) => sum + (record.bytes || 0), 0);
        if (total <= DOWNLOAD_LIMIT_BYTES) return;
        const oldest = done.slice().sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
        return oldest.reduce((chain, record) => chain.then(() => {
            if (total <= DOWNLOAD_LIMIT_BYTES) return null;
            total -= record.bytes || 0;
            downloadTasks.delete(record.key);
            return deleteEpisodeDownload(record.key);
        }), Promise.resolve());
    }).catch(() => {});
}

function pumpDownloadQueue() {
    while (downloadActiveCount < DOWNLOAD_EPISODE_CONCURRENCY && downloadQueue.length) {
        const task = downloadQueue.shift();
        if (!task || task.cancelled) continue;
        downloadActiveCount += 1;
        runDownloadTask(task).finally(() => {
            downloadActiveCount -= 1;
            pumpDownloadQueue();
        });
    }
}

function queueEpisodeDownload({ title, index, label, url, episodes, episodeNames, cover, sourceName, sourceCode, info }) {
    if (!isDownloadSupported()) return { ok: false, reason: '当前环境不支持离线下载' };
    if (!url) return { ok: false, reason: '这一集没有可下载的地址' };
    const key = downloadEpisodeKey(title, index);
    const existing = downloadTasks.get(key);
    if (existing && (existing.status === 'downloading' || existing.status === 'queued')) {
        return { ok: false, reason: '这一集正在下载' };
    }
    const task = {
        key, title, index: Number(index) || 0, label: label || '', url,
        // 这些信息是给「下载管理」页用的：从那里点播放要能还原出完整剧集列表和来源
        episodes: Array.isArray(episodes) && episodes.length ? episodes.slice() : [url],
        episodeNames: Array.isArray(episodeNames) ? episodeNames.slice() : [],
        cover: cover || '',
        sourceName: sourceName || '',
        sourceCode: sourceCode || '',
        info: info || null,
        status: 'queued', done: 0, total: 0, bytes: 0, error: '', cancelled: false, controller: null
    };
    downloadTasks.set(key, task);
    downloadQueue.push(task);
    notifyDownloadListeners();
    pumpDownloadQueue();
    return { ok: true, key };
}

function cancelEpisodeDownload(key) {
    const task = downloadTasks.get(key);
    if (!task) return false;
    task.cancelled = true;
    if (task.controller) {
        try { task.controller.abort(); } catch (e) { /* 已中断 */ }
    }
    if (task.status === 'queued') {
        task.status = 'cancelled';
        const position = downloadQueue.indexOf(task);
        if (position >= 0) downloadQueue.splice(position, 1);
    }
    notifyDownloadListeners();
    return true;
}

// 下载记录要能还原出来源信息，管理页从那里点播放才不会丢来源和封面
function downloadSourceMeta() {
    let sourceName = '';
    let sourceCode = '';
    try {
        if (typeof URLSearchParams === 'function' && typeof window !== 'undefined' && window.location) {
            const params = new URLSearchParams(window.location.search);
            sourceName = params.get('source') || '';
            sourceCode = params.get('source_code') || '';
        }
    } catch (e) {
        sourceName = '';
        sourceCode = '';
    }
    let info = null;
    let cover = '';
    try {
        info = JSON.parse(localStorage.getItem('currentVideoInfo') || 'null');
        cover = localStorage.getItem('currentVideoCover') || '';
    } catch (e) {
        info = null;
        cover = '';
    }
    return {
        cover,
        info,
        sourceName: sourceName || (info && info.sourceName) || '',
        sourceCode: sourceCode || (info && info.sourceCode) || ''
    };
}

function downloadEpisodeByIndex(index) {
    if (!currentEpisodes || !currentEpisodes[index]) return { ok: false, reason: '这一集没有可下载的地址' };
    const meta = downloadSourceMeta();
    return queueEpisodeDownload({
        title: currentVideoTitle,
        index,
        label: getEpisodeLabel(index),
        url: currentEpisodes[index],
        episodes: currentEpisodes,
        episodeNames: currentEpisodeNames,
        cover: meta.cover,
        sourceName: meta.sourceName,
        sourceCode: meta.sourceCode,
        info: meta.info
    });
}

function downloadCurrentEpisode() {
    return downloadEpisodeByIndex(currentEpisodeIndex);
}

// 剧集列表上那个小图标的三态切换：没下过 → 加入队列，下载中 → 取消，已下好 → 删除
function toggleEpisodeDownload(index) {
    if (!currentEpisodes || !currentEpisodes[index]) return { ok: false, reason: '这一集没有可下载的地址' };
    const key = downloadEpisodeKey(currentVideoTitle, index);
    const task = downloadTasks.get(key);
    if (task && (task.status === 'downloading' || task.status === 'queued')) {
        cancelEpisodeDownload(key);
        return { ok: true, message: '已取消下载' };
    }
    if (isEpisodeDownloaded(currentVideoTitle, index)) {
        deleteEpisodeDownload(key)
            .then(() => refreshDownloadedKeys())
            .then(() => notifyDownloadListeners());
        return { ok: true, message: '已删除这一集的离线文件' };
    }
    const result = downloadEpisodeByIndex(index);
    return result.ok ? { ok: true, message: '已加入下载队列' } : result;
}

async function downloadSummary() {
    const rows = await listDownloadedEpisodes();
    const done = rows.filter(record => record.status === 'done');
    const bytes = done.reduce((sum, record) => sum + (record.bytes || 0), 0);
    return {
        supported: isDownloadSupported(),
        count: done.length,
        bytes,
        limit: DOWNLOAD_LIMIT_BYTES,
        active: downloadActiveCount,
        queued: downloadQueue.length,
        rows
    };
}

async function downloadClear() {
    const rows = await listDownloadedEpisodes();
    downloadTasks.clear();
    downloadQueue.length = 0;
    await rows.reduce((chain, record) => chain.then(() => deleteEpisodeDownload(record.key)), Promise.resolve());
    await refreshDownloadedKeys();
    notifyDownloadListeners();
}
