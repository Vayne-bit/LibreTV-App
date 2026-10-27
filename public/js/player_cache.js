// hls.js 分片磁盘缓存
//
// 采集站片源码率高、线路抖动大，同一集往回拖或重看时每个分片都要重新下载。
// 这里把下载过的媒体分片写进 IndexedDB，命中时直接喂给 hls.js，省掉一次网络往返。
//
// 注意收益边界：只对「下载过的分片」有效（回看、重看、恢复进度），
// 拖到没看过的新位置仍然要等网络，这部分靠 player_buffer.js 的等缓冲逻辑兜。

const SEGMENT_CACHE_DB = 'libretvSegmentCache';
const SEGMENT_CACHE_VERSION = 1;
const SEGMENT_CACHE_STORE = 'segments';
const SEGMENT_CACHE_META_STORE = 'segmentMeta';
const SEGMENT_CACHE_STORAGE_KEY = 'segmentCacheEnabled';
const SEGMENT_CACHE_LIMIT_BYTES = 400 * 1000 * 1000;
const SEGMENT_CACHE_MAX_ENTRY_BYTES = 16 * 1000 * 1000;
const SEGMENT_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const SEGMENT_CACHE_PRUNE_EVERY_WRITES = 20;

let segmentCacheDb = null;
let segmentCacheDbPromise = null;
let segmentCachePruneTimer = null;
let segmentCacheWritesSincePrune = 0;
let segmentCacheHlsRef = null;

const segmentCacheStats = {
    supported: true,
    hits: 0,
    misses: 0,
    bytesRead: 0,
    bytesWritten: 0
};

function readSegmentCacheEnabled() {
    try {
        return localStorage.getItem(SEGMENT_CACHE_STORAGE_KEY) !== 'false';
    } catch (e) {
        return true;
    }
}

let segmentCacheEnabled = readSegmentCacheEnabled();

function setSegmentCacheEnabled(value) {
    segmentCacheEnabled = !!value;
    try {
        localStorage.setItem(SEGMENT_CACHE_STORAGE_KEY, segmentCacheEnabled ? 'true' : 'false');
    } catch (e) { /* 隐私模式下写不进去，只在本次生效 */ }
}

function isSegmentCacheSupported() {
    return typeof indexedDB !== 'undefined' && !!indexedDB;
}

// 播放器换片/换集时要更新，缓存命中时用它反推「这些字节真从网上下要多久」
function bindSegmentCacheHls(hls) {
    segmentCacheHlsRef = hls || null;
}

function segmentCacheBandwidthEstimate() {
    const hls = segmentCacheHlsRef;
    let estimate = hls ? Number(hls.bandwidthEstimate) : NaN;
    if (!isFinite(estimate) || estimate <= 0) {
        estimate = (hls && hls.config && Number(hls.config.abrEwmaDefaultEstimate)) || 500000;
    }
    return estimate;
}

function openSegmentCacheDb() {
    if (!isSegmentCacheSupported()) {
        segmentCacheStats.supported = false;
        return Promise.resolve(null);
    }
    if (segmentCacheDb) return Promise.resolve(segmentCacheDb);
    if (segmentCacheDbPromise) return segmentCacheDbPromise;
    segmentCacheDbPromise = new Promise(resolve => {
        let request;
        try {
            request = indexedDB.open(SEGMENT_CACHE_DB, SEGMENT_CACHE_VERSION);
        } catch (e) {
            segmentCacheStats.supported = false;
            return resolve(null);
        }
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(SEGMENT_CACHE_STORE)) {
                db.createObjectStore(SEGMENT_CACHE_STORE);
            }
            if (!db.objectStoreNames.contains(SEGMENT_CACHE_META_STORE)) {
                const meta = db.createObjectStore(SEGMENT_CACHE_META_STORE);
                meta.createIndex('lastUsed', 'lastUsed', { unique: false });
            }
        };
        request.onsuccess = () => {
            segmentCacheDb = request.result;
            // 另一个标签页升级库版本时让出连接，否则会一直阻塞对方
            segmentCacheDb.onversionchange = () => {
                try { segmentCacheDb.close(); } catch (e) { /* ignore */ }
                segmentCacheDb = null;
            };
            resolve(segmentCacheDb);
        };
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
    });
    return segmentCacheDbPromise;
}

// 只缓存媒体分片：manifest/level 是播放列表（体积小，hls.js 自己有内存缓存），
// 密钥请求没有 type 字段，缓存下来既没意义也有风险
function isSegmentCacheCandidate(context) {
    if (!segmentCacheEnabled || !context) return false;
    if (context.type !== 'main' && context.type !== 'audio' && context.type !== 'subtitle') return false;
    if (context.responseType && context.responseType !== 'arraybuffer') return false;
    const url = String(context.url || '');
    if (!url || url.indexOf('blob:') === 0 || url.indexOf('data:') === 0) return false;
    return true;
}

// 同一个 URL 可能有多个 byte-range 请求，key 必须带上范围，否则会串味
function segmentCacheKey(context) {
    if (!context || !context.url) return '';
    const start = Number(context.rangeStart) || 0;
    const end = Number(context.rangeEnd) || 0;
    return start || end ? `${context.url}#${start}-${end}` : String(context.url);
}

function segmentCacheNoteHit(bytes) {
    segmentCacheStats.hits++;
    segmentCacheStats.bytesRead += Number(bytes) || 0;
}

function segmentCacheNoteMiss() {
    segmentCacheStats.misses++;
}

function segmentCacheGet(key) {
    if (!segmentCacheEnabled || !key) return Promise.resolve(null);
    return openSegmentCacheDb().then(db => {
        if (!db) return null;
        return new Promise(resolve => {
            let tx;
            try {
                tx = db.transaction([SEGMENT_CACHE_STORE, SEGMENT_CACHE_META_STORE], 'readwrite');
            } catch (e) {
                return resolve(null);
            }
            const segments = tx.objectStore(SEGMENT_CACHE_STORE);
            const meta = tx.objectStore(SEGMENT_CACHE_META_STORE);
            let buffer = null;
            const segmentRequest = segments.get(key);
            segmentRequest.onsuccess = () => { buffer = segmentRequest.result || null; };
            segmentRequest.onerror = () => { buffer = null; };
            // 顺手更新 lastUsed，让 LRU 淘汰按真实使用顺序走
            // meta store 没设 keyPath，put 必须显式带 key，否则会抛 DataError
            const metaRequest = meta.get(key);
            metaRequest.onsuccess = () => {
                const record = metaRequest.result;
                if (!record) return;
                record.lastUsed = Date.now();
                try { meta.put(record, key); } catch (e) { /* ignore */ }
            };
            tx.oncomplete = () => resolve(buffer);
            tx.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
        });
    }).catch(() => null);
}

function segmentCachePut(key, buffer, url) {
    if (!segmentCacheEnabled || !key || !buffer) return Promise.resolve(false);
    const size = Number(buffer.byteLength) || 0;
    // 单条太大的分片不存：超过 16MB 的媒体分片基本是 4K 长分片，
    // 写进去一次就要占掉 4% 的配额，回看收益抵不上空间代价
    if (!size || size > SEGMENT_CACHE_MAX_ENTRY_BYTES) return Promise.resolve(false);
    return openSegmentCacheDb().then(db => {
        if (!db) return false;
        return new Promise(resolve => {
            let tx;
            try {
                tx = db.transaction([SEGMENT_CACHE_STORE, SEGMENT_CACHE_META_STORE], 'readwrite');
            } catch (e) {
                return resolve(false);
            }
            const now = Date.now();
            tx.objectStore(SEGMENT_CACHE_STORE).put(buffer, key);
            tx.objectStore(SEGMENT_CACHE_META_STORE).put({ size, lastUsed: now, at: now, url: String(url || '') }, key);
            tx.oncomplete = () => {
                segmentCacheStats.bytesWritten += size;
                segmentCacheWritesSincePrune++;
                if (segmentCacheWritesSincePrune >= SEGMENT_CACHE_PRUNE_EVERY_WRITES) {
                    segmentCacheWritesSincePrune = 0;
                    segmentCachePrune().catch(() => {});
                }
                resolve(true);
            };
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        });
    }).catch(() => false);
}

// 网络拿到的分片顺手存一份。必须在 onSuccess 里同步拷贝一份：
// hls.js 之后会把这块 buffer transfer 给 worker，晚一步再存就是 detached 的了
function storeSegmentFromResponse(context, response) {
    if (!segmentCacheEnabled) return;
    const data = response && response.data;
    if (!data) return;
    let copy = null;
    try {
        // 用 toString 和 ArrayBuffer.isView 判断，别用 instanceof：
        // 跨 realm（比如 buffer 从 worker 传回来）时 instanceof 会误判成 false
        if (Object.prototype.toString.call(data) === '[object ArrayBuffer]') {
            copy = data.slice(0);
        } else if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView(data)) {
            // 视图类型（Uint8Array 等）：只取自己那一段，别把整个底层 buffer 存下来
            const offset = data.byteOffset || 0;
            copy = data.buffer.slice(offset, offset + (data.byteLength || 0));
        }
    } catch (e) {
        return;
    }
    if (!copy || !copy.byteLength) return;
    const key = segmentCacheKey(context);
    if (!key) return;
    segmentCachePut(key, copy, context.url).catch(() => {});
}

// 缓存命中时伪造一份 stats。hls.js 在 onFragBuffered 里用
// (parsing.end - loading.start - ttfb) 和 loaded 算带宽采样，
// 如果直接给 0 耗时，它会以为网络突然变快，立刻升到撑不住的码率，缓冲反而更容易被抽干。
function prepareSegmentCacheStats(stats, byteLength) {
    if (!stats) return stats;
    const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const bytes = Math.max(1, Number(byteLength) || 1);
    const estimate = segmentCacheBandwidthEstimate();
    const simulatedMs = Math.max(100, (bytes * 8) / Math.max(estimate, 1) * 1000);
    const ttfbMs = Math.min(simulatedMs, 120);
    stats.loading.start = now - simulatedMs;
    stats.loading.first = now - simulatedMs + ttfbMs;
    stats.loading.end = now;
    stats.loaded = bytes;
    stats.total = bytes;
    stats.bwEstimate = estimate;
    stats.aborted = false;
    stats.chunkCount = 1;
    stats.parsing.start = now;
    stats.parsing.end = now;
    stats.buffering.start = now;
    stats.buffering.end = now;
    return stats;
}

// 先清过期，再按最久未用淘汰到配额以内
function segmentCachePrune() {
    if (segmentCachePruneTimer) {
        clearTimeout(segmentCachePruneTimer);
        segmentCachePruneTimer = null;
    }
    return openSegmentCacheDb().then(db => {
        if (!db) return null;
        return new Promise(resolve => {
            let tx;
            try {
                tx = db.transaction([SEGMENT_CACHE_STORE, SEGMENT_CACHE_META_STORE], 'readwrite');
            } catch (e) {
                return resolve(null);
            }
            const segments = tx.objectStore(SEGMENT_CACHE_STORE);
            const meta = tx.objectStore(SEGMENT_CACHE_META_STORE);
            const rows = [];
            const cursorRequest = meta.index('lastUsed').openCursor();
            cursorRequest.onsuccess = () => {
                const cursor = cursorRequest.result;
                if (cursor) {
                    const value = cursor.value || {};
                    rows.push({ key: cursor.primaryKey, size: Number(value.size) || 0, lastUsed: Number(value.lastUsed) || 0 });
                    cursor.continue();
                    return;
                }
                // 游标走完了，事务还活着，可以继续发删除请求
                const now = Date.now();
                const doomed = [];
                const seen = new Set();
                let total = 0;
                rows.forEach(row => { total += row.size; });
                rows.forEach(row => {
                    if (!row.lastUsed || now - row.lastUsed > SEGMENT_CACHE_MAX_AGE_MS) {
                        doomed.push(row);
                        seen.add(row.key);
                        total -= row.size;
                    }
                });
                for (let i = 0; i < rows.length && total > SEGMENT_CACHE_LIMIT_BYTES; i++) {
                    const row = rows[i];
                    if (seen.has(row.key)) continue;
                    doomed.push(row);
                    seen.add(row.key);
                    total -= row.size;
                }
                doomed.forEach(row => {
                    try {
                        segments.delete(row.key);
                        meta.delete(row.key);
                    } catch (e) { /* ignore */ }
                });
            };
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(null);
            tx.onabort = () => resolve(null);
        });
    }).catch(() => null);
}

function segmentCacheClear() {
    segmentCacheStats.hits = 0;
    segmentCacheStats.misses = 0;
    segmentCacheStats.bytesRead = 0;
    segmentCacheStats.bytesWritten = 0;
    return openSegmentCacheDb().then(db => {
        if (!db) return false;
        return new Promise(resolve => {
            let tx;
            try {
                tx = db.transaction([SEGMENT_CACHE_STORE, SEGMENT_CACHE_META_STORE], 'readwrite');
            } catch (e) {
                return resolve(false);
            }
            tx.objectStore(SEGMENT_CACHE_STORE).clear();
            tx.objectStore(SEGMENT_CACHE_META_STORE).clear();
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => resolve(false);
            tx.onabort = () => resolve(false);
        });
    }).catch(() => false);
}

function segmentCacheSummary() {
    const summary = {
        supported: isSegmentCacheSupported() && segmentCacheStats.supported,
        enabled: segmentCacheEnabled,
        entries: 0,
        bytes: 0,
        hits: segmentCacheStats.hits,
        misses: segmentCacheStats.misses,
        bytesRead: segmentCacheStats.bytesRead,
        bytesWritten: segmentCacheStats.bytesWritten,
        limitBytes: SEGMENT_CACHE_LIMIT_BYTES
    };
    if (!summary.supported || !segmentCacheEnabled) return Promise.resolve(summary);
    return openSegmentCacheDb().then(db => {
        if (!db) return summary;
        return new Promise(resolve => {
            let tx;
            try {
                tx = db.transaction([SEGMENT_CACHE_META_STORE], 'readonly');
            } catch (e) {
                return resolve(summary);
            }
            const request = tx.objectStore(SEGMENT_CACHE_META_STORE).openCursor();
            request.onsuccess = () => {
                const cursor = request.result;
                if (!cursor) return;
                summary.entries++;
                summary.bytes += Number((cursor.value || {}).size) || 0;
                cursor.continue();
            };
            tx.oncomplete = () => resolve(summary);
            tx.onerror = () => resolve(summary);
        });
    }).catch(() => summary);
}

// 首次打开页面时顺手清一次过期条目，避免攒了几个月才触发
if (isSegmentCacheSupported() && segmentCacheEnabled) {
    segmentCachePruneTimer = setTimeout(() => {
        segmentCachePruneTimer = null;
        segmentCachePrune().catch(() => {});
    }, 8000);
}
