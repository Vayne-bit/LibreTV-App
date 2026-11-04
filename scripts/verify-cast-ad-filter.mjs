// 投屏端广告过滤：端到端联调验证
//
// 验证完整链路：前端判定广告块 → 产出广告分片 URI 名单 → Rust 侧按名单剔除。
// 用真实站源清单（40 个样本）跑，检查三件事：
//   1. 前端产出的名单里没有正片分片（名单本身正确）
//   2. Rust 按名单剔除后，剩下的清单与前端过滤结果一致（两端行为等价）
//   3. 正片分片一个都没少（投屏不能删错，比删漏严重得多）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SAMPLES = process.argv[2] || path.join(process.cwd(), 'samples');
const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'manifest.json'), 'utf8'));

// ---------------- 前端沙箱（真实源码）----------------
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

const handlerSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_artplayer_handler.js'), 'utf8');
const locatorSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_ad_locator.js'), 'utf8')
    .replace('})(window);', '})(globalThis);');
const PRELUDE = `
const AD_BLOCK_MAX_SECONDS = 300; const AD_REMOVE_MAX_RATIO = 0.3;
const AD_HOST_PATTERNS = ['doubleclick.net','googlesyndication','googleadservices','admob','adnxs.com','pubmatic.com','rubiconproject.com','criteo.com','adcolony','vungle.com','applovin','mopub.com','unityads','inmobi.com','taboola.com','outbrain.com','moatads.com','amazon-adsystem','tanx.com','mediav.com','miaozhen.com','ipinyou.com','adsame','admaster','adview.cn','allyes.com','adchina.com'];
const AD_PATH_PATTERN = /(^|\\/)(ads?|adverts?|advertising|adcreative|adplayer|adframe|bannerads?|popunder|interstitial|preroll|midroll|postroll)(\\/|$)/i;
const LEARNED_AD_HOSTS_KEY = 'learnedAdHosts'; const PLAYLIST_MARKER_STATS_KEY = 'playlistMarkerStats';
const rawPlaylistCache = new Map(); const RAW_PLAYLIST_CACHE_MAX = 4;
let lastRawPlaylist = null; let lastRemovedSegmentIds = new Set();
`;
const sandbox = {
    window: {}, console, URL, Date, Set, Map, Math, JSON, parseFloat, Object, Array, Number, String, RegExp, isNaN,
    localStorage: { _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k]; }, setItem(k, v) { this._d[k] = String(v); } },
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(PRELUDE + locatorSrc + '\n' + extractFunctions(handlerSrc, [
    'isDiscontinuityLine', 'splitPlaylistBlocks', 'playlistHost', 'playlistPathPrefix',
    'isAdSegmentUri', 'getLearnedAdHosts', 'rememberAdHosts', 'recordAdFilterStats',
    'filterByHostRules', 'isAdStartTag', 'isAdEndTag', 'filterByStructure',
    'findAdBlockIndexes', 'filterAdsFromM3U8', 'finishFiltering', 'computeRemovedSegmentIds',
    'parseRawPlaylist', 'segmentIdentity', 'playlistCacheKey', 'getRawPlaylist',
    'rememberRawPlaylist', 'getRemovedSegmentIds', 'getRemovedSegmentUris',
    
]) + '\nglobalThis.__api = { filterAdsFromM3U8, getRemovedSegmentUris, getRemovedSegmentIds, parseRawPlaylist, splitPlaylistBlocks, rememberRawPlaylist };', ctx);
const api = sandbox.__api;

// ---------------- Rust 逻辑复刻（与 dlna.rs 同规则，用于交叉验证）----------------
// Rust 侧：整块删的条件 = 块内有分片 且 块内每个分片都在广告名单里
function rustRewritePlaylist(text, playlistUrl, adUris) {
    if (!adUris.length) return { blocks: splitRust(text), removed: [] };
    const blocks = splitRust(text);
    const removed = [];
    blocks.forEach((block, index) => {
        if (!block.segments.length) return;
        const allAd = block.segments.every(line => {
            const trimmed = line.trim();
            const resolved = resolveRust(playlistUrl, trimmed);
            return adUris.includes(trimmed) || adUris.includes(resolved);
        });
        if (allAd) removed.push(index);
    });
    return { blocks, removed };
}

function splitRust(text) {
    const blocks = [];
    let block = { discontinuity: false, lines: [], segments: [] };
    text.split('\n').forEach(line => {
        const t = line.trim();
        if (t === '#EXT-X-DISCONTINUITY' || t.startsWith('#EXT-X-DISCONTINUITY:')) {
            blocks.push(block);
            block = { discontinuity: true, lines: [], segments: [] };
            return;
        }
        block.lines.push(line);
        if (t && t[0] !== '#') block.segments.push(line);
    });
    blocks.push(block);
    return blocks;
}

// Rust 的 resolve_url 语义（目录相对）
function resolveRust(base, target) {
    if (!target) return '';
    const lower = target.toLowerCase();
    if (lower.startsWith('http://') || lower.startsWith('https://')) return target;
    const idx = base.indexOf('://');
    if (idx < 0) return '';
    const scheme = base.slice(0, idx);
    const rest = base.slice(idx + 3);
    const authorityEnd = rest.indexOf('/');
    const authority = authorityEnd < 0 ? rest : rest.slice(0, authorityEnd);
    if (lower.startsWith('//')) return `${scheme}:${target}`;
    if (target.startsWith('/')) return `${scheme}://${authority}${target}`;
    const path = authorityEnd < 0 ? '' : rest.slice(authorityEnd);
    const lastSlash = path.lastIndexOf('/');
    const dirEnd = lastSlash < 0 ? authorityEnd : authorityEnd + lastSlash + 1;
    return `${scheme}://${authority}${path.slice(0, dirEnd)}${target}`;
}

// ---------------- 独立真值 ----------------
function prefixOf(uri) {
    try {
        const u = new URL(uri, 'https://placeholder.invalid/');
        return u.host + u.pathname.replace(/[^/]*$/, '');
    } catch (e) { return ''; }
}

function groundTruth(text) {
    const blocks = [];
    let block = { discontinuity: false, keyNone: false, segments: [], duration: 0 };
    let pending = 0;
    text.split('\n').forEach(line => {
        const t = line.trim();
        if (t === '#EXT-X-DISCONTINUITY' || t.startsWith('#EXT-X-DISCONTINUITY:')) {
            blocks.push(block);
            block = { discontinuity: true, keyNone: false, segments: [], duration: 0 };
            return;
        }
        if (t.startsWith('#EXT-X-KEY')) {
            if (t.includes('METHOD=NONE')) block.keyNone = true;
            return;
        }
        if (t.startsWith('#EXTINF')) {
            const v = parseFloat(t.slice(8));
            pending = isNaN(v) ? 0 : v;
            return;
        }
        if (t && t[0] !== '#') {
            block.segments.push({ uri: t, duration: pending });
            block.duration += pending;
            pending = 0;
        }
    });
    blocks.push(block);
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
        uris: b.segments.map(s => s.uri),
        isAd: b.segments.length > 0 && b.segments.every(s => !contentUris.has(s.uri)),
    }));
}

// ---------------- 跑 ----------------
let tp = 0, fp = 0, fn = 0;
let mismatch = 0, listPolluted = 0;
const details = [];

manifest.forEach(item => {
    const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
    const baseUrl = item.url;
    const truth = groundTruth(text);

    // 模拟真实运行路径：hls.js loader 先留存原始清单，再走过滤
    api.rememberRawPlaylist(text, baseUrl);
    api.filterAdsFromM3U8(text, true, baseUrl);
    const adUris = api.getRemovedSegmentUris();

    // 检查名单本身：里面不能有正片分片
    const contentUris = new Set();
    truth.forEach(b => { if (!b.isAd) b.uris.forEach(u => contentUris.add(u)); });
    const polluted = adUris.filter(u => contentUris.has(u));
    if (polluted.length) {
        listPolluted++;
        details.push(`[${item.site}] ${item.keyword}：广告名单里混进了正片分片 ${polluted.length} 个`);
    }

    // Rust 侧按名单剔除
    const { blocks, removed } = rustRewritePlaylist(text, baseUrl, adUris);
    const removedUris = new Set();
    removed.forEach(i => blocks[i].segments.forEach(line => removedUris.add(line.trim())));

    // 与真值比对
    removed.forEach(i => {
        if (truth[i] && truth[i].isAd) tp++;
        else { fp++; details.push(`[${item.site}] ${item.keyword}：Rust 误删块${i}`); }
    });
    truth.forEach(b => {
        if (b.isAd && !removed.includes(b.index)) fn++;
    });

    // 一致性：Rust 删掉的分片集合应与前端名单一致
    const listSet = new Set(adUris);
    const same = removedUris.size === listSet.size &&
        [...removedUris].every(u => listSet.has(u));
    if (!same) {
        mismatch++;
        details.push(`[${item.site}] ${item.keyword}：两端剔除结果不一致（Rust ${removedUris.size} 个 vs 前端名单 ${listSet.size} 个）`);
    }
});

console.log('\n=== 投屏端广告过滤：端到端联调验证 ===\n');
console.log(`样本 ${manifest.length} 个真实清单`);
console.log(`\n【判定正确性】`);
console.log(`  正确识别广告 ${tp} 块 / 误删正片 ${fp} 块 / 漏删广告 ${fn} 块`);
console.log(`  精确率 ${tp + fp > 0 ? (tp / (tp + fp) * 100).toFixed(1) + '%' : 'N/A'}`);
console.log(`\n【名单安全性】`);
console.log(listPolluted === 0
    ? '  传出去的广告名单里没有正片分片 ✅'
    : `  广告名单混入正片分片 ${listPolluted} 个样本 ❌`);
console.log(`\n【两端一致性】`);
console.log(mismatch === 0
    ? '  Rust 剔除结果与前端名单完全一致 ✅'
    : `  ${mismatch} 个样本两端不一致 ❌`);

if (details.length) {
    console.log('\n=== 异常明细 ===');
    details.slice(0, 20).forEach(d => console.log('  ' + d));
}

// ---------------- 边界场景：master 清单后加载 ----------------
// hls.js 先加载 master 再加载媒体清单；若 master 后到并覆盖了缓存，
// 名单就取错了清单（master 里没有分片）→ 投屏等于没过滤。
// 名单在过滤收尾时即记下，所以与后续缓存变动无关。
console.log('\n=== 边界场景：master 清单在媒体清单之后加载 ===');
{
    const item = manifest.find(x => x.site === '360zy' && x.file.includes('_3_'))
        || manifest.find(x => x.site === '360zy');
    const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
    const baseUrl = item.url;

    // 按真实顺序：媒体清单 → 过滤
    api.rememberRawPlaylist(text, baseUrl);
    api.filterAdsFromM3U8(text, true, baseUrl);

    const truth = groundTruth(text);
    const expectedUris = new Set();
    truth.filter(b => b.isAd).forEach(b => b.uris.forEach(u => expectedUris.add(u)));

    // 场景 A：master 用不同 URL 后加载（真实情况 —— 两层清单 URL 不同）
    const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\n1981kb/hls/index.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=400000\n955kb/hls/index.m3u8\n';
    api.rememberRawPlaylist(master, baseUrl + '?variant=master');
    let got = new Set(api.getRemovedSegmentUris());
    let hit = [...expectedUris].filter(u => got.has(u)).length;
    console.log(`  A. master 换 URL 后加载：名单含 ${hit}/${expectedUris.size} 个广告分片`);

    // 场景 B：master 用同一 URL 覆盖缓存（更极端：缓存被完全顶掉）
    api.rememberRawPlaylist(master, baseUrl);
    got = new Set(api.getRemovedSegmentUris());
    hit = [...expectedUris].filter(u => got.has(u)).length;
    console.log(`  B. master 覆盖同 URL 缓存：名单含 ${hit}/${expectedUris.size} 个广告分片`);

    const ok = expectedUris.size === 0
        || (hit === expectedUris.size);
    if (expectedUris.size === 0) {
        console.log('  （该样本无广告块，跳过）');
    } else if (ok) {
        console.log('  ✅ 名单不受缓存变动影响，广告过滤不会失效');
    } else {
        console.log('  ❌ 名单受缓存变动影响，广告过滤会失效');
        process.exitCode = 1;
    }
}

process.exit(fp > 0 || listPolluted > 0 || mismatch > 0 ? 1 : 0);
