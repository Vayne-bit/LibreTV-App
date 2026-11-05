// ============ 音乐模块核心：状态与存储 ============
// 队列/收藏/最近播放持久化在 localStorage；离线曲目在 IndexedDB（music_download.js）。

const MUSIC_STATE_KEY = 'musicState';       // 队列 + 当前位置 + 上次播放曲目
const MUSIC_FAV_KEY = 'musicFavorites';     // 收藏
const MUSIC_RECENT_KEY = 'musicRecent';     // 最近播放（自动）

const musicState = {
    queue: [],          // [musicItem]
    index: -1,          // 当前播放的队列下标
    playing: false,
    // 当前曲目的播放地址（含备用），供重试/下载复用，避免重复解析
    currentSource: null // { url, headers?, size?, bitrate? }
};

function musicSafeRead(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
        return fallback;
    }
}

function musicSafeWrite(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 存储满不致命 */ }
}

// 音乐项的唯一键：平台 + id（与 MusicFree 的平台内 id 语义一致）
function musicKey(item) {
    if (!item) return '';
    return (item.platform || '') + '|' + (item.id || '');
}

function loadMusicState() {
    const saved = musicSafeRead(MUSIC_STATE_KEY, null);
    if (saved && Array.isArray(saved.queue)) {
        musicState.queue = saved.queue.filter(item => item && item.platform && item.id);
        musicState.index = Number(saved.index) || 0;
        if (musicState.index >= musicState.queue.length) musicState.index = musicState.queue.length ? 0 : -1;
    }
}

function saveMusicState() {
    musicSafeWrite(MUSIC_STATE_KEY, {
        queue: musicState.queue.slice(0, 200),
        index: musicState.index
    });
}

function loadMusicFavorites() {
    return musicSafeRead(MUSIC_FAV_KEY, []);
}

function saveMusicFavorites(list) {
    musicSafeWrite(MUSIC_FAV_KEY, list.slice(0, 500));
}

function isMusicFavorite(item) {
    const key = musicKey(item);
    return loadMusicFavorites().some(item2 => musicKey(item2) === key);
}

function toggleMusicFavorite(item) {
    const key = musicKey(item);
    const list = loadMusicFavorites();
    const idx = list.findIndex(item2 => musicKey(item2) === key);
    if (idx >= 0) {
        list.splice(idx, 1);
        saveMusicFavorites(list);
        return false;
    }
    list.unshift(Object.assign({}, item, { favAt: Date.now() }));
    saveMusicFavorites(list);
    return true;
}

function pushMusicRecent(item) {
    const list = musicSafeRead(MUSIC_RECENT_KEY, []);
    const key = musicKey(item);
    const kept = list.filter(item2 => musicKey(item2) !== key);
    kept.unshift(Object.assign({}, item, { playedAt: Date.now() }));
    musicSafeWrite(MUSIC_RECENT_KEY, kept.slice(0, 100));
}

function getMusicRecent() {
    return musicSafeRead(MUSIC_RECENT_KEY, []);
}

// 队列操作：播放在最前插入（"下一首播"），追加在尾部
function musicQueueInsertNext(item) {
    const key = musicKey(item);
    const pos = musicState.queue.findIndex(item2 => musicKey(item2) === key);
    if (pos >= 0) musicState.queue.splice(pos, 1);
    const insertAt = musicState.index >= 0 ? musicState.index + 1 : 0;
    musicState.queue.splice(insertAt, 0, Object.assign({}, item));
    if (musicState.index < 0) musicState.index = 0;
    saveMusicState();
}

function musicQueueAppend(item) {
    const key = musicKey(item);
    if (musicState.queue.some(item2 => musicKey(item2) === key)) return;
    musicState.queue.push(Object.assign({}, item));
    if (musicState.index < 0) musicState.index = 0;
    saveMusicState();
}

function musicQueueRemoveAt(index) {
    if (index < 0 || index >= musicState.queue.length) return;
    musicState.queue.splice(index, 1);
    if (musicState.index > index) musicState.index -= 1;
    else if (musicState.index === index) musicState.index = Math.min(musicState.index, musicState.queue.length - 1);
    saveMusicState();
}

function formatMusicDuration(seconds) {
    const value = Number(seconds) || 0;
    if (!value || !isFinite(value)) return '';
    const m = Math.floor(value / 60);
    const s = Math.floor(value % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
}

function formatMusicBytes(bytes) {
    const value = Number(bytes) || 0;
    if (value <= 0) return '0 MB';
    if (value < 1000 * 1000) return Math.max(1, Math.round(value / 1000)) + ' KB';
    if (value < 1000 * 1000 * 1000) return (value / 1000 / 1000).toFixed(1) + ' MB';
    return (value / 1000 / 1000 / 1000).toFixed(2) + ' GB';
}

// 热门搜索预设（替代已失效的榜单抓取接口——2026-11-05 实测 m.kugou 榜单壳接口已不返回内容）
const MUSIC_HOT_KEYWORDS = ['热门金曲', '华语新歌', '经典老歌', '影视金曲', '网络热歌', '欧美热歌', '轻音乐', '抖音热歌', '粤语经典', '民谣'];
