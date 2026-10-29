// 跨设备同步地基：统一作品标识、精简同步载荷、冲突合并
// 这一层不依赖任何云端，先保证"同一部片能被正确认出"

const SYNC_CONFIG_KEY = 'syncConfig';
const SYNC_LAST_AT_KEY = 'syncLastAt';
const SYNC_EPISODE_HINT_COUNT = 3;

// --- 作品标识 ---

// 标题归一化：去掉部/季/第X季这类噪声、标点、空格，用于跨源对齐
function normalizeTitleForSync(name) {
    return String(name || '')
        .replace(/[\s\p{P}]/gu, '')
        .replace(/第[一二三四五六七八九十零0-9]+[季部期]/g, '')
        .toLowerCase();
}

// 从标题里抠出年份，常见写法 2024、(2024)、【2024】
function extractYearFromTitle(name) {
    const match = String(name || '').match(/(?:^|[^\d])(19\d{2}|20\d{2})(?:[^\d]|$)/);
    return match ? match[1] : '';
}

// 一部片在不同源里的唯一标识：归一化标题 + 年份
// 没有年份时只用标题，会有一定碰撞概率，这是当前数据源能支持的最好方案
function buildCanonicalId(title, year) {
    const t = normalizeTitleForSync(title);
    if (!t) return '';
    const y = String(year || extractYearFromTitle(title) || '').trim();
    return y ? `${t}@${y}` : t;
}

// --- 同步载荷 ---

// 只同步跨设备真正需要的字段；episodes 全量太大，只留前几条作为溯源线索
function slimHistoryEntry(item) {
    if (!item) return null;
    const canonic = item.canonicalId
        || buildCanonicalId(item.title, item.year || extractYearFromTitle(item.title));
    if (!canonic) return null;
    return {
        canonicalId: canonic,
        title: item.title || '',
        year: item.year || extractYearFromTitle(item.title) || '',
        episodeIndex: typeof item.episodeIndex === 'number' ? item.episodeIndex : 0,
        playbackPosition: typeof item.playbackPosition === 'number' ? item.playbackPosition : 0,
        duration: typeof item.duration === 'number' ? item.duration : 0,
        timestamp: item.timestamp || 0,
        cover: item.cover || '',
        sourceName: item.sourceName || '',
        sourceCode: item.sourceCode || '',
        vodId: item.vodId || '',
        // 仅供溯源，不作为播放依据（源地址会失效）
        episodesHint: Array.isArray(item.episodes) ? item.episodes.slice(0, SYNC_EPISODE_HINT_COUNT) : []
    };
}

function slimFavoriteEntry(item) {
    if (!item) return null;
    const canonic = buildCanonicalId(item.title, item.year || extractYearFromTitle(item.title));
    if (!canonic) return null;
    return {
        canonicalId: canonic,
        title: item.title || '',
        year: item.year || '',
        cover: item.cover || '',
        type: item.type || '',
        remarks: item.remarks || '',
        episodeCount: item.episodeCount || 0,
        seenCount: item.seenCount || 0,
        addedAt: item.addedAt || 0,
        sourceCode: item.sourceCode || '',
        id: String(item.id || '')
    };
}

// 打包本机需要同步的数据
// devices 记录参与同步的设备，合并时按设备名去重，用于在设置页展示
// deleted 是本机的删除标记，带上去别的设备才知道这些记录是删掉的而不是还没同步到
function buildSyncPayload() {
    const history = readJsonArray(LOCAL_KEYS.history);
    const favorites = readJsonArray(LOCAL_KEYS.favorites);
    const devices = mergeDeviceList(readDeviceList(), [currentDeviceInfo()]);
    const tombstones = readTombstones();
    return {
        version: 2,
        updatedAt: Date.now(),
        history: history.map(slimHistoryEntry).filter(Boolean),
        favorites: favorites.map(slimFavoriteEntry).filter(Boolean),
        devices,
        deleted: tombstones
    };
}

// 本机信息，用于设备列表展示
function currentDeviceInfo() {
    const name = typeof syncDeviceName === 'function' ? syncDeviceName() : '设备';
    const ua = navigator.userAgent || '';
    let platform = '未知';
    if (/Android/i.test(ua)) platform = 'Android';
    else if (/Windows/i.test(ua)) platform = 'Windows';
    else if (/Mac/i.test(ua)) platform = 'macOS';
    else if (/Linux/i.test(ua)) platform = 'Linux';
    return { name, platform, lastSeen: Date.now() };
}

function readDeviceList() {
    try {
        const list = JSON.parse(localStorage.getItem('syncDevices') || '[]');
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}

function writeDeviceList(list) {
    localStorage.setItem('syncDevices', JSON.stringify(list || []));
}

// 按设备名去重，保留较新的 lastSeen
function mergeDeviceList(local, remote) {
    const byName = new Map();
    [...(local || []), ...(remote || [])].forEach(item => {
        if (!item || !item.name) return;
        const existing = byName.get(item.name);
        if (!existing || (item.lastSeen || 0) > (existing.lastSeen || 0)) {
            byName.set(item.name, item);
        }
    });
    return [...byName.values()].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
}

const LOCAL_KEYS = {
    history: 'viewingHistory',
    favorites: 'favorites'
};

function readJsonArray(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(value) ? value : [];
    } catch (e) {
        return [];
    }
}

// --- 删除标记（tombstone） ---
// 合并是纯并集，本地删掉的记录下一轮从云端拉回来又会被并进来。
// 所以删除要留个记号，合并时按记号过滤，并跟着一起推到云端，别的设备也会跟着删。
const SYNC_TOMBSTONE_KEY = 'syncTombstones';
const SYNC_TOMBSTONE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

function readTombstones() {
    let stored = null;
    try {
        stored = JSON.parse(localStorage.getItem(SYNC_TOMBSTONE_KEY) || 'null');
    } catch (e) {
        stored = null;
    }
    const map = stored && typeof stored === 'object' ? stored : {};
    const history = map.history && typeof map.history === 'object' ? map.history : {};
    const favorites = map.favorites && typeof map.favorites === 'object' ? map.favorites : {};
    return { history, favorites };
}

function writeTombstones(tombstones) {
    const cutoff = Date.now() - SYNC_TOMBSTONE_MAX_AGE_MS;
    const prune = source => {
        const kept = {};
        Object.keys(source || {}).forEach(id => {
            const at = Number(source[id]) || 0;
            if (at && at >= cutoff) kept[id] = at;
        });
        return kept;
    };
    const payload = {
        history: prune(tombstones && tombstones.history),
        favorites: prune(tombstones && tombstones.favorites)
    };
    try {
        localStorage.setItem(SYNC_TOMBSTONE_KEY, JSON.stringify(payload));
    } catch (e) { /* 存不下就算了，下次删除还会再写 */ }
    return payload;
}

// 条目可能还没有 canonicalId（老数据），这里现算一个，保证删得掉
function syncTombstoneId(item) {
    if (!item) return '';
    if (item.canonicalId) return item.canonicalId;
    const title = item.title || '';
    if (!title) return '';
    return buildCanonicalId(title, item.year || extractYearFromTitle(title));
}

// kind: 'history' | 'favorites'
function markSyncDeleted(kind, itemOrId) {
    const id = typeof itemOrId === 'string' ? itemOrId : syncTombstoneId(itemOrId);
    if (!id) return false;
    const tombstones = readTombstones();
    const bucket = tombstones[kind] || (tombstones[kind] = {});
    bucket[id] = Date.now();
    writeTombstones(tombstones);
    return true;
}

function markSyncDeletedMany(kind, items) {
    const tombstones = readTombstones();
    const bucket = tombstones[kind] || (tombstones[kind] = {});
    const now = Date.now();
    let marked = 0;
    (items || []).forEach(item => {
        const id = syncTombstoneId(item);
        if (!id) return;
        bucket[id] = now;
        marked++;
    });
    writeTombstones(tombstones);
    return marked;
}

// 把远端带来的删除标记并进本地，同一个 id 取较晚的时间
function mergeTombstoneMaps(local, remote) {
    const result = { history: {}, favorites: {} };
    ['history', 'favorites'].forEach(kind => {
        const merged = {};
        const take = source => {
            Object.keys(source || {}).forEach(id => {
                const at = Number(source[id]) || 0;
                if (!at) return;
                if (!merged[id] || at > merged[id]) merged[id] = at;
            });
        };
        take(local && local[kind]);
        take(remote && remote[kind]);
        result[kind] = merged;
    });
    return result;
}


// --- 合并 ---

// 按 canonicalId 对齐，时间戳新的胜出；保留本机原有的剧集列表等重字段。
// tombstones 是删除标记表：标记时间不早于条目时间的条目一律丢掉，
// 但如果条目在删除之后又有新进度（重新看过），说明用户改主意了，让它回来。
function mergeSyncList(localList, remoteList, slimFn, mergeInto, tombstones) {
    const deleted = tombstones || {};
    const deletedAt = id => Number(deleted[id]) || 0;
    const byId = new Map();
    (localList || []).forEach(item => {
        const slim = slimFn(item);
        if (!slim) return;
        const stamp = slim.timestamp || slim.addedAt || 0;
        if (deletedAt(slim.canonicalId) >= stamp) return;
        byId.set(slim.canonicalId, { slim, original: item });
    });
    (remoteList || []).forEach(remote => {
        if (!remote || !remote.canonicalId) return;
        const remoteTime = remote.timestamp || remote.addedAt || 0;
        if (deletedAt(remote.canonicalId) >= remoteTime) return;
        const existing = byId.get(remote.canonicalId);
        if (!existing) {
            byId.set(remote.canonicalId, { slim: remote, original: null });
            return;
        }
        // 谁的时间戳新用谁的进度
        const localTime = existing.slim.timestamp || existing.slim.addedAt || 0;
        if (remoteTime > localTime) {
            byId.set(remote.canonicalId, {
                slim: remote,
                original: mergeInto ? mergeInto(existing.original, remote) : existing.original
            });
        }
    });
    return [...byId.values()];
}

// 把远端进度套到本机的完整条目上，保留本机的 episodes 等播放必需字段
function mergeHistoryEntry(localItem, remoteItem) {
    if (!localItem) return null;
    return {
        ...localItem,
        canonicalId: remoteItem.canonicalId,
        episodeIndex: remoteItem.episodeIndex,
        playbackPosition: remoteItem.playbackPosition,
        duration: remoteItem.duration || localItem.duration,
        timestamp: Math.max(localItem.timestamp || 0, remoteItem.timestamp || 0),
        cover: remoteItem.cover || localItem.cover,
        sourceName: remoteItem.sourceName || localItem.sourceName
    };
}

// 远端有新片但本机没有完整数据时，只能存精简版：能显示，但需要重新搜源才能播
function buildEntryFromRemote(remoteItem) {
    return {
        canonicalId: remoteItem.canonicalId,
        title: remoteItem.title,
        year: remoteItem.year || '',
        episodeIndex: remoteItem.episodeIndex || 0,
        playbackPosition: remoteItem.playbackPosition || 0,
        duration: remoteItem.duration || 0,
        timestamp: remoteItem.timestamp || 0,
        cover: remoteItem.cover || '',
        sourceName: remoteItem.sourceName || '',
        sourceCode: remoteItem.sourceCode || '',
        vodId: remoteItem.vodId || '',
        directVideoUrl: '',
        url: '',
        episodes: Array.isArray(remoteItem.episodesHint) ? remoteItem.episodesHint.slice() : [],
        episodeNames: [],
        // 标记为"仅同步而来"，播放前需要重新定位片源
        needsRelink: true
    };
}

function mergeHistory(localHistory, remoteHistory, tombstones) {
    const merged = mergeSyncList(localHistory, remoteHistory, slimHistoryEntry, mergeHistoryEntry, tombstones);
    const result = merged.map(({ slim, original }) => {
        if (original) return mergeHistoryEntry(original, slim);
        return buildEntryFromRemote(slim);
    });
    result.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return result.slice(0, 50);
}

function mergeFavorites(localFavorites, remoteFavorites, tombstones) {
    const merged = mergeSyncList(localFavorites, remoteFavorites, slimFavoriteEntry, null, tombstones);
    return merged.map(({ slim, original }) => {
        if (original) {
            return {
                ...original,
                canonicalId: slim.canonicalId,
                seenCount: Math.max(original.seenCount || 0, slim.seenCount || 0),
                episodeCount: Math.max(original.episodeCount || 0, slim.episodeCount || 0)
            };
        }
        return {
            id: slim.id || slim.canonicalId,
            sourceCode: slim.sourceCode || '',
            sourceName: '',
            title: slim.title,
            cover: slim.cover,
            type: slim.type,
            year: slim.year,
            remarks: slim.remarks,
            episodeCount: slim.episodeCount,
            seenCount: slim.seenCount,
            hasUpdate: false,
            addedAt: slim.addedAt || 0,
            checkedAt: 0,
            canonicalId: slim.canonicalId,
            needsRelink: true
        };
    });
}

// 把远端数据并入本机 localStorage，返回统计信息
function applySyncPayload(payload) {
    if (!payload || !Array.isArray(payload.history)) {
        return { ok: false, reason: '数据格式无效' };
    }
    const localHistory = readJsonArray(LOCAL_KEYS.history);
    const localFavorites = readJsonArray(LOCAL_KEYS.favorites);

    // 先把双方的删除标记合起来，再拿它去过滤，这样两边删过的都不会被对方拉回来
    const tombstones = writeTombstones(mergeTombstoneMaps(readTombstones(), payload.deleted));

    const mergedHistory = mergeHistory(localHistory, payload.history, tombstones.history);
    const mergedFavorites = mergeFavorites(localFavorites, payload.favorites || [], tombstones.favorites);

    localStorage.setItem(LOCAL_KEYS.history, JSON.stringify(mergedHistory));
    localStorage.setItem(LOCAL_KEYS.favorites, JSON.stringify(mergedFavorites));
    localStorage.setItem(SYNC_LAST_AT_KEY, String(Date.now()));

    // 记下参与同步的设备，供设置页展示
    const devices = mergeDeviceList(readDeviceList(), [
        ...(Array.isArray(payload.devices) ? payload.devices : []),
        currentDeviceInfo()
    ]);
    writeDeviceList(devices);

    return {
        ok: true,
        historyBefore: localHistory.length,
        historyAfter: mergedHistory.length,
        favoritesBefore: localFavorites.length,
        favoritesAfter: mergedFavorites.length,
        // 远端有、本机没有完整数据的条目，播放前需要重新搜源
        relinkNeeded: mergedHistory.filter(item => item.needsRelink).length
    };
}

// --- 为已有历史补 canonicalId（一次性迁移） ---

function backfillCanonicalIds() {
    let changed = 0;
    [LOCAL_KEYS.history, LOCAL_KEYS.favorites].forEach(key => {
        const list = readJsonArray(key);
        let dirty = false;
        list.forEach(item => {
            if (!item.canonicalId) {
                const id = buildCanonicalId(item.title, item.year || extractYearFromTitle(item.title));
                if (id) {
                    item.canonicalId = id;
                    dirty = true;
                    changed++;
                }
            }
        });
        if (dirty) localStorage.setItem(key, JSON.stringify(list));
    });
    return changed;
}

// --- 同步凭证（阶段二用，先定义好结构） ---

function readSyncConfig() {
    try {
        const cfg = JSON.parse(localStorage.getItem(SYNC_CONFIG_KEY) || 'null');
        return cfg && cfg.code ? cfg : null;
    } catch (e) {
        return null;
    }
}

function writeSyncConfig(config) {
    if (!config) {
        localStorage.removeItem(SYNC_CONFIG_KEY);
        return;
    }
    localStorage.setItem(SYNC_CONFIG_KEY, JSON.stringify(config));
}

function lastSyncAt() {
    const value = parseInt(localStorage.getItem(SYNC_LAST_AT_KEY) || '0', 10);
    return isNaN(value) ? 0 : value;
}
