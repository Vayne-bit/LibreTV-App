// 广告过滤改造回归验证
//
// 验证两件事：
//   1. public/js/player_artplayer_handler.js（模块化版，判据来自 player_ad_locator.js）
//   2. js/player.js（单文件版，判据内联）—— 两版行为必须一致
//
// 真值判定独立于被测代码：
//   「真广告块」= 该块所有分片 URI 在正片主体里一次都没出现过
//   「正片主体」= 不含 DISCONTINUITY+KEY_NONE 组合的块 ∪ 时长占比最大前缀的所有块
// 这样不依赖任何一套待测判据，避免循环论证。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SAMPLES = process.argv[2] || path.join(process.cwd(), 'samples');
const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'manifest.json'), 'utf8'));

// ---------------- 抽取源码里的函数 ----------------
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

// 抽取模块级 const（内联判据用到的常量不在函数体里，漏抽会 ReferenceError）
function extractConsts(src, pattern) {
    const out = [];
    const re = new RegExp(pattern, 'gm');
    let m;
    while ((m = re.exec(src))) out.push(m[0]);
    return out.join('\n');
}

// ---------------- 搭沙箱 ----------------
function makeSandbox() {
    const sandbox = {
        window: {}, console, URL, Date, Set, Map, Math, JSON, parseFloat, Object, Array, Number, String, RegExp, isNaN,
        localStorage: {
            _d: {},
            getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
            setItem(k, v) { this._d[k] = String(v); },
        },
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    return vm.createContext(sandbox);
}

// 两版共用的模块级常量/状态（沙箱里必须补齐，否则 ReferenceError）
const PRELUDE = `
const AD_BLOCK_MAX_SECONDS = 300;
const AD_REMOVE_MAX_RATIO = 0.3;
const AD_HOST_PATTERNS = [
  'doubleclick.net','googlesyndication','googleadservices','admob','adnxs.com',
  'pubmatic.com','rubiconproject.com','criteo.com','adcolony','vungle.com',
  'applovin','mopub.com','unityads','inmobi.com','taboola.com','outbrain.com',
  'moatads.com','amazon-adsystem','tanx.com','mediav.com','miaozhen.com',
  'ipinyou.com','adsame','admaster','adview.cn','allyes.com','adchina.com'
];
const AD_PATH_PATTERN = /(^|\\/)(ads?|adverts?|advertising|adcreative|adplayer|adframe|bannerads?|popunder|interstitial|preroll|midroll|postroll)(\\/|$)/i;
const LEARNED_AD_HOSTS_KEY = 'learnedAdHosts';
const PLAYLIST_MARKER_STATS_KEY = 'playlistMarkerStats';
const rawPlaylistCache = new Map();
const removedSegmentsByPlaylist = new Map();
const RAW_PLAYLIST_CACHE_MAX = 4;
let lastRawPlaylist = null;
let lastRemovedSegmentIds = new Set();
`;

// ---------------- public 版（判据来自 player_ad_locator.js）----------------
const publicSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_artplayer_handler.js'), 'utf8');
// locator 用 `(function(global){...})(window)` 挂载，沙箱里改成挂 globalThis，
// 这样 `typeof AdBlockLocator` 才成立（与浏览器里 window === globalThis 的语义一致）
const locatorSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_ad_locator.js'), 'utf8')
    .replace('})(window);', '})(globalThis);');

const PUBLIC_FNS = [
    'isDiscontinuityLine', 'splitPlaylistBlocks', 'playlistHost', 'playlistPathPrefix',
    'isAdSegmentUri', 'getLearnedAdHosts', 'rememberAdHosts', 'recordAdFilterStats',
    'filterByHostRules', 'isAdStartTag', 'isAdEndTag', 'filterByStructure',
    'findAdBlockIndexes', 'filterAdsFromM3U8', 'parseRawPlaylist', 'segmentIdentity',
    'computeRemovedSegmentIds', 'finishFiltering', 'getRawPlaylist', 'rememberRawPlaylist',
    'playlistCacheKey',
];
const publicCtx = makeSandbox();
vm.runInContext(PRELUDE + locatorSrc + '\n' + extractFunctions(publicSrc, PUBLIC_FNS) +
    '\nglobalThis.__api = { filterAdsFromM3U8, filterByStructure, splitPlaylistBlocks, playlistHost };', publicCtx);

// ---------------- 根目录单文件版（判据内联）----------------
const rootSrc = fs.readFileSync(path.join(process.cwd(), 'js/player.js'), 'utf8');
const ROOT_FNS = [
    'isDiscontinuityLine', 'splitPlaylistBlocks', 'playlistHost', 'playlistPathPrefix',
    'isAdSegmentUri', 'getLearnedAdHosts', 'rememberAdHosts', 'recordAdFilterStats',
    'filterByHostRules', 'isAdStartTag', 'isAdEndTag', 'filterByStructure',
    'findAdBlockIndexes', 'findAdBlockCandidates', 'adBlockIsUniformDuration',
    'adBlockSinglePrefix', 'filterAdsFromM3U8',
];
const rootCtx = makeSandbox();
// 根版把判据内联在文件里，常量（AD_LOCATOR_*）在函数体外，必须一并抽出来
const rootConsts = extractConsts(rootSrc, '^const AD_LOCATOR_[A-Z_]+ = [^;]+;');
vm.runInContext(PRELUDE + rootConsts + '\n' + extractFunctions(rootSrc, ROOT_FNS) +
    '\nglobalThis.__api = { filterAdsFromM3U8, filterByStructure, splitPlaylistBlocks, playlistHost };', rootCtx);

const publicApi = publicCtx.__api;
const rootApi = rootCtx.__api;

// ---------------- 独立切块 + 真值判定 ----------------
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

// 真值：广告块 = 整块分片 URI 在正片主体里一次都没出现过
function groundTruth(text) {
    const blocks = splitIndependent(text);
    // 正片主体：不含 DISCONTINUITY+KEY_NONE 组合的块
    const contentUris = new Set();
    blocks.forEach(b => {
        if (!(b.discontinuity && b.keyNone)) b.segments.forEach(s => contentUris.add(s.uri));
    });
    // 时长占比最大前缀的块也属于正片主体
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
    return blocks.map(b => ({
        index: blocks.indexOf(b),
        discontinuity: b.discontinuity,
        keyNone: b.keyNone,
        segCount: b.segments.length,
        duration: b.duration,
        uris: b.segments.map(s => s.uri),
        prefixes: [...new Set(b.segments.map(s => prefixOf(s.uri)))],
        // 真广告：分片 URI 与正片主体零重叠
        isAd: b.segments.length > 0 && b.segments.every(s => !contentUris.has(s.uri)),
    }));
}

// ---------------- 跑 ----------------
function runVersion(api, text, baseUrl) {
    const truth = groundTruth(text);
    const filtered = api.filterAdsFromM3U8(text, true, baseUrl);
    const keptUris = [];
    filtered.split('\n').forEach(l => {
        const t = l.trim();
        if (t && t.charAt(0) !== '#') keptUris.push(t);
    });
    const keptSet = new Set(keptUris);
    const removed = truth.filter(b => b.segCount > 0 && !b.uris.every(u => keptSet.has(u)));
    const tp = removed.filter(b => b.isAd);
    const fp = removed.filter(b => !b.isAd);
    const fn = truth.filter(b => b.isAd && !removed.includes(b));
    return { truth, filtered, removed, tp, fp, fn };
}

const results = { public: [], root: [], mismatch: [] };
manifest.forEach(item => {
    const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
    const baseUrl = item.url;
    const p = runVersion(publicApi, text, baseUrl);
    const r = runVersion(rootApi, text, baseUrl);
    results.public.push({ item, ...p });
    results.root.push({ item, ...r });
    // 两版结果必须一致
    const pIdx = p.removed.map(b => b.index).sort().join(',');
    const rIdx = r.removed.map(b => b.index).sort().join(',');
    if (pIdx !== rIdx) {
        results.mismatch.push({ file: item.file, site: item.site, publicIdx: pIdx, rootIdx: rIdx });
    }
});

function summarize(name, rows) {
    const agg = rows.reduce((a, x) => ({ tp: a.tp + x.tp.length, fp: a.fp + x.fp.length, fn: a.fn + x.fn.length }), { tp: 0, fp: 0, fn: 0 });
    const removedBlocks = rows.reduce((n, x) => n + x.removed.length, 0);
    console.log(`\n=== ${name} ===`);
    console.log(`样本 ${rows.length} 个，实际删除 ${removedBlocks} 块`);
    console.log(`正确识别广告 ${agg.tp} 块 / 误伤正片 ${agg.fp} 块 / 漏删广告 ${agg.fn} 块`);
    console.log(`精确率 ${agg.tp + agg.fp > 0 ? (agg.tp / (agg.tp + agg.fp) * 100).toFixed(1) + '%' : 'N/A'}`);
    const fpSites = [...new Set(rows.filter(x => x.fp.length).map(x => x.item.site))];
    console.log(fpSites.length ? `误伤站点：${fpSites.join(', ')}` : '零误伤');
    rows.filter(x => x.removed.length).forEach(x => {
        console.log(`  [${x.item.site}] ${x.item.keyword}`);
        x.removed.forEach(b => {
            const verdict = b.isAd ? '广告' : '误伤';
            console.log(`     块${b.index}: ${b.segCount}片/${Math.round(b.duration)}s 前缀=${b.prefixes.join(',')} → ${verdict}`);
        });
        x.fn.forEach(b => {
            console.log(`     漏删 块${b.index}: ${b.segCount}片/${Math.round(b.duration)}s 前缀=${b.prefixes.join(',')}`);
        });
    });
    return agg;
}

console.log('广告过滤改造回归验证（真值=分片 URI 与正片主体零重叠）\n');
const pubAgg = summarize('public/js/player_artplayer_handler.js', results.public);
const rootAgg = summarize('js/player.js（单文件版）', results.root);

console.log('\n=== 两版一致性 ===');
if (results.mismatch.length) {
    console.log(`不一致 ${results.mismatch.length} 个样本：`);
    results.mismatch.slice(0, 10).forEach(m => console.log(`   ${m.file} public=[${m.publicIdx}] root=[${m.rootIdx}]`));
} else {
    console.log('两版删除的块完全一致');
}

fs.writeFileSync(path.join(SAMPLES, 'regression-report.json'), JSON.stringify({
    public: results.public.map(r => ({
        site: r.item.site, keyword: r.item.keyword, url: r.item.url,
        removed: r.removed.map(b => ({ idx: b.index, segs: b.segCount, dur: Math.round(b.duration), ad: b.isAd })),
        fn: r.fn.map(b => b.index),
    })),
    mismatch: results.mismatch,
}, null, 2), 'utf8');
