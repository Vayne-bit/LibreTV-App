// 改造前后严格对比：同一套真值、同一批样本，跑旧宽判据 vs 新严判据。
//
// 真值定义（独立于任何一套待测判据）：
//   「真广告块」= 该块所有分片 URI 在正片主体里一次都没出现过
//   「正片主体」= 不含 DISCONTINUITY+KEY_NONE 组合的块 ∪ 时长占比最大前缀的所有块
//
// 之所以要独立真值：若用待测判据的输出当真值，严判据的误伤会恒为 0，结论自证。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SAMPLES = process.argv[2] || path.join(process.cwd(), 'samples');
const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'manifest.json'), 'utf8'));

function extractFunctions(src, names) {
    const out = [];
    names.forEach(name => {
        const start = src.indexOf('function ' + name + '(');
        if (start < 0) throw new Error('未找到函数 ' + name);
        let depth = 0;
        let i = src.indexOf('{', start);
        for (; i < src.length; i++) {
            const ch = src[i];
            if (ch === '{') depth++;
            else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
        }
        out.push(src.slice(start, i));
    });
    return out.join('\n\n');
}

function extractConsts(src, pattern) {
    const out = [];
    const re = new RegExp(pattern, 'gm');
    let m;
    while ((m = re.exec(src))) out.push(m[0]);
    return out.join('\n');
}

const PRELUDE = `
const AD_BLOCK_MAX_SECONDS = 300; const AD_REMOVE_MAX_RATIO = 0.3;
const AD_HOST_PATTERNS = ['doubleclick.net','googlesyndication','googleadservices','admob','adnxs.com','pubmatic.com','rubiconproject.com','criteo.com','adcolony','vungle.com','applovin','mopub.com','unityads','inmobi.com','taboola.com','outbrain.com','moatads.com','amazon-adsystem','tanx.com','mediav.com','miaozhen.com','ipinyou.com','adsame','admaster','adview.cn','allyes.com','adchina.com'];
const AD_PATH_PATTERN = /(^|\\/)(ads?|adverts?|advertising|adcreative|adplayer|adframe|bannerads?|popunder|interstitial|preroll|midroll|postroll)(\\/|$)/i;
const LEARNED_AD_HOSTS_KEY = 'learnedAdHosts'; const PLAYLIST_MARKER_STATS_KEY = 'playlistMarkerStats';
const rawPlaylistCache = new Map(); const RAW_PLAYLIST_CACHE_MAX = 4;
const removedSegmentsByPlaylist = new Map(); // 分键的「被删分片名单」（与 handler 内同名常量一致）
let lastRawPlaylist = null; let lastRemovedSegmentIds = new Set();
`;

// ---------- 沙箱（每个版本独立，localStorage 隔离）----------
function makeSandbox() {
    const sandbox = {
        window: {}, console, URL, Date, Set, Map, Math, JSON, parseFloat, Object, Array, Number, String, RegExp, isNaN,
        localStorage: { _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k]; }, setItem(k, v) { this._d[k] = String(v); } },
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    return vm.createContext(sandbox);
}

const COMMON_FNS = [
    'isDiscontinuityLine', 'splitPlaylistBlocks', 'playlistHost', 'playlistPathPrefix',
    'isAdSegmentUri', 'getLearnedAdHosts', 'rememberAdHosts', 'recordAdFilterStats',
    'filterByHostRules', 'isAdStartTag', 'isAdEndTag', 'filterByStructure', 'filterAdsFromM3U8',
];

// ---- 旧版（宽判据）：从 git HEAD 取 ----
const oldSrc = fs.readFileSync(path.join(process.cwd(), '..', '_old_handler.js'), 'utf8');
const OLD_FNS = COMMON_FNS.concat(['finishFiltering', 'computeRemovedSegmentIds',
    'parseRawPlaylist', 'segmentIdentity', 'playlistCacheKey', 'getRawPlaylist', 'rememberRawPlaylist']);
const oldCtx = makeSandbox();
vm.runInContext(PRELUDE + extractFunctions(oldSrc, OLD_FNS) +
    '\nglobalThis.__api = { filterAdsFromM3U8, splitPlaylistBlocks, playlistHost };', oldCtx);

// ---- 新版（严判据）：public 版，用真实 locator ----
const newSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_artplayer_handler.js'), 'utf8');
const locatorSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_ad_locator.js'), 'utf8')
    .replace('})(window);', '})(globalThis);');
const NEW_FNS = COMMON_FNS.concat(['findAdBlockIndexes', 'finishFiltering', 'computeRemovedSegmentIds',
    'parseRawPlaylist', 'segmentIdentity', 'playlistCacheKey', 'getRawPlaylist', 'rememberRawPlaylist']);
const newCtx = makeSandbox();
vm.runInContext(PRELUDE + locatorSrc + '\n' + extractFunctions(newSrc, NEW_FNS) +
    '\nglobalThis.__api = { filterAdsFromM3U8, splitPlaylistBlocks, playlistHost };', newCtx);

const oldApi = oldCtx.__api;
const newApi = newCtx.__api;

// ---------- 独立切块 + 真值 ----------
function splitIndependent(text) {
    const blocks = [];
    let block = { discontinuity: false, keyNone: false, segments: [], duration: 0 };
    let pending = 0;
    text.split('\n').forEach(line => {
        const t = line.trim();
        if (t === '#EXT-X-DISCONTINUITY' || t.indexOf('#EXT-X-DISCONTINUITY:') === 0) {
            blocks.push(block);
            block = { discontinuity: true, keyNone: false, segments: [], duration: 0 };
            return;
        }
        if (t.indexOf('#EXT-X-KEY') === 0) {
            if (t.indexOf('METHOD=NONE') >= 0) block.keyNone = true;
            return;
        }
        if (t.indexOf('#EXTINF') === 0) {
            const v = parseFloat(t.slice(8));
            pending = isNaN(v) ? 0 : v;
            return;
        }
        if (t && t.charAt(0) !== '#') {
            block.segments.push({ uri: t, duration: pending });
            block.duration += pending;
            pending = 0;
        }
    });
    blocks.push(block);
    return blocks;
}

function prefixOf(uri) {
    try {
        const u = new URL(uri, 'https://placeholder.invalid/');
        return u.host + u.pathname.replace(/[^/]*$/, '');
    } catch (e) { return ''; }
}

function groundTruth(text) {
    const blocks = splitIndependent(text);
    const contentUris = new Set();
    blocks.forEach(b => {
        if (!(b.discontinuity && b.keyNone)) b.segments.forEach(s => contentUris.add(s.uri));
    });
    const prefixDur = new Map();
    blocks.forEach(b => {
        const ps = new Set(b.segments.map(s => prefixOf(s.uri)));
        if (ps.size !== 1) return;
        const p = [...ps][0];
        prefixDur.set(p, (prefixDur.get(p) || 0) + b.duration);
    });
    let mainPrefix = '';
    let best = -1;
    prefixDur.forEach((d, p) => { if (d > best) { best = d; mainPrefix = p; } });
    blocks.forEach(b => {
        const ps = new Set(b.segments.map(s => prefixOf(s.uri)));
        if (ps.size === 1 && [...ps][0] === mainPrefix) b.segments.forEach(s => contentUris.add(s.uri));
    });
    return blocks.map((b, i) => ({
        index: i,
        segCount: b.segments.length,
        duration: b.duration,
        uris: b.segments.map(s => s.uri),
        prefixes: [...new Set(b.segments.map(s => prefixOf(s.uri)))],
        isAd: b.segments.length > 0 && b.segments.every(s => !contentUris.has(s.uri)),
    }));
}

function runVersion(api, text, baseUrl) {
    const truth = groundTruth(text);
    const filtered = api.filterAdsFromM3U8(text, true, baseUrl);
    const kept = new Set();
    filtered.split('\n').forEach(l => {
        const t = l.trim();
        if (t && t.charAt(0) !== '#') kept.add(t);
    });
    const removed = truth.filter(b => b.segCount > 0 && !b.uris.every(u => kept.has(u)));
    return {
        truth, removed,
        tp: removed.filter(b => b.isAd),
        fp: removed.filter(b => !b.isAd),
        fn: truth.filter(b => b.isAd && !removed.includes(b)),
    };
}

const rows = [];
manifest.forEach(item => {
    const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
    const baseUrl = item.url;
    const o = runVersion(oldApi, text, baseUrl);
    const n = runVersion(newApi, text, baseUrl);
    rows.push({ item, old: o, new: n });
});

function agg(rs, key) {
    return rs.reduce((a, r) => ({
        tp: a.tp + r[key].tp.length,
        fp: a.fp + r[key].fp.length,
        fn: a.fn + r[key].fn.length,
        removed: a.removed + r[key].removed.length,
    }), { tp: 0, fp: 0, fn: 0, removed: 0 });
}

const oAgg = agg(rows, 'old');
const nAgg = agg(rows, 'new');

console.log('\n=== 改造前后对比（40 个真实清单，同一套独立真值）===\n');
console.log('                    旧版宽判据      新版严判据');
console.log(`删除块总数          ${String(oAgg.removed).padStart(10)}${String(nAgg.removed).padStart(14)}`);
console.log(`正确识别广告        ${String(oAgg.tp).padStart(10)}${String(nAgg.tp).padStart(14)}`);
console.log(`误伤正片            ${String(oAgg.fp).padStart(10)}${String(nAgg.fp).padStart(14)}`);
console.log(`漏删广告            ${String(oAgg.fn).padStart(10)}${String(nAgg.fn).padStart(14)}`);
const oPrec = oAgg.tp + oAgg.fp > 0 ? (oAgg.tp / (oAgg.tp + oAgg.fp) * 100).toFixed(1) + '%' : 'N/A';
const nPrec = nAgg.tp + nAgg.fp > 0 ? (nAgg.tp / (nAgg.tp + nAgg.fp) * 100).toFixed(1) + '%' : 'N/A';
const oRec = oAgg.tp + oAgg.fn > 0 ? (oAgg.tp / (oAgg.tp + oAgg.fn) * 100).toFixed(1) + '%' : 'N/A';
const nRec = nAgg.tp + nAgg.fn > 0 ? (nAgg.tp / (nAgg.tp + nAgg.fn) * 100).toFixed(1) + '%' : 'N/A';
console.log(`精确率              ${oPrec.padStart(10)}${nPrec.padStart(14)}`);
console.log(`召回率              ${oRec.padStart(10)}${nRec.padStart(14)}`);

console.log('\n=== 有差异的样本 ===');
let diff = 0;
rows.forEach(r => {
    const oIdx = r.old.removed.map(b => b.index).sort().join(',');
    const nIdx = r.new.removed.map(b => b.index).sort().join(',');
    if (oIdx === nIdx) return;
    diff++;
    console.log(`\n[${r.item.site}] ${r.item.keyword}`);
    console.log(`  旧版删 [${oIdx || '无'}]：${r.old.removed.map(b => `块${b.index}(${b.isAd ? '广告' : '误伤'})`).join(' ') || '无'}`);
    console.log(`  新版删 [${nIdx || '无'}]：${r.new.removed.map(b => `块${b.index}(${b.isAd ? '广告' : '误伤'})`).join(' ') || '无'}`);
    if (r.old.fp.length) {
        console.log(`  旧版误伤明细：${r.old.fp.map(b => `块${b.index} ${b.segCount}片/${Math.round(b.duration)}s 前缀=${b.prefixes.join(',')}`).join(' | ')}`);
    }
    if (r.new.fn.length) {
        console.log(`  新版漏删明细：${r.new.fn.map(b => `块${b.index} ${b.segCount}片/${Math.round(b.duration)}s 前缀=${b.prefixes.join(',')}`).join(' | ')}`);
    }
});
if (!diff) console.log('两版删除结果完全一致');

console.log('\n=== 结论 ===');
console.log(oAgg.fp > 0 ? `旧版误伤 ${oAgg.fp} 块正片 —— 这是必须修掉的` : '旧版零误伤');
console.log(nAgg.fp === 0 ? '新版零误伤 ✅' : `新版仍误伤 ${nAgg.fp} 块 ❌`);
console.log(nAgg.fn <= oAgg.fn ? `新版漏删 ${nAgg.fn} 块（不比旧版差）` : `新版漏删变多 ❌（旧版 ${oAgg.fn} → 新版 ${nAgg.fn}）`);
