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
function buildSyncPayload() {
    const history = readJsonArray(LOCAL_KEYS.history);
    const favorites = readJsonArray(LOCAL_KEYS.favorites);
    return {
        version: 1,
        updatedAt: Date.now(),
        history: history.map(slimHistoryEntry).filter(Boolean),
        favorites: favorites.map(slimFavoriteEntry).filter(Boolean)
    };
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

// --- 合并 ---

// 按 canonicalId 对齐，时间戳新的胜出；保留本机原有的剧集列表等重字段
function mergeSyncList(localList, remoteList, slimFn, mergeInto) {
    const byId = new Map();
    (localList || []).forEach(item => {
        const slim = slimFn(item);
        if (!slim) return;
        byId.set(slim.canonicalId, { slim, original: item });
    });
    (remoteList || []).forEach(remote => {
        if (!remote || !remote.canonicalId) return;
        const existing = byId.get(remote.canonicalId);
        if (!existing) {
            byId.set(remote.canonicalId, { slim: remote, original: null });
            return;
        }
        // 谁的时间戳新用谁的进度
        const remoteTime = remote.timestamp || remote.addedAt || 0;
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

function mergeHistory(localHistory, remoteHistory) {
    const merged = mergeSyncList(localHistory, remoteHistory, slimHistoryEntry, mergeHistoryEntry);
    const result = merged.map(({ slim, original }) => {
        if (original) return mergeHistoryEntry(original, slim);
        return buildEntryFromRemote(slim);
    });
    result.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    return result.slice(0, 50);
}

function mergeFavorites(localFavorites, remoteFavorites) {
    const merged = mergeSyncList(localFavorites, remoteFavorites, slimFavoriteEntry, null);
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

    const mergedHistory = mergeHistory(localHistory, payload.history);
    const mergedFavorites = mergeFavorites(localFavorites, payload.favorites || []);

    localStorage.setItem(LOCAL_KEYS.history, JSON.stringify(mergedHistory));
    localStorage.setItem(LOCAL_KEYS.favorites, JSON.stringify(mergedFavorites));
    localStorage.setItem(SYNC_LAST_AT_KEY, String(Date.now()));

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
