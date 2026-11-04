// 广告过滤压力测试：主动构造边界场景，界定误判风险边界。
//
// 真实样本只能证明「没出问题」，压力测试才能回答「什么情况下会出问题」。
// 每个场景标注期望行为，脚本自动判定通过与否。
//
// 同时验证两版（public 模块化版 / 根目录单文件版），结果必须一致。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

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

function makeSandbox() {
    const store = { _d: {} };
    const sandbox = {
        window: {}, console, URL, Date, Set, Map, Math, JSON, parseFloat, Object, Array, Number, String, RegExp, isNaN,
        localStorage: {
            getItem(k) { return store._d[k] === undefined ? null : store._d[k]; },
            setItem(k, v) { store._d[k] = String(v); },
            // 每个场景前清空：学习型广告黑名单是跨会话状态，
            // 不隔离的话上一个场景学到的域名会污染下一个场景的结果
            __reset() { store._d = {}; },
        },
    };
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    return vm.createContext(sandbox);
}

const PRELUDE = `
const AD_BLOCK_MAX_SECONDS = 300; const AD_REMOVE_MAX_RATIO = 0.3;
const AD_HOST_PATTERNS = ['doubleclick.net','googlesyndication','googleadservices','admob','adnxs.com','pubmatic.com','rubiconproject.com','criteo.com','adcolony','vungle.com','applovin','mopub.com','unityads','inmobi.com','taboola.com','outbrain.com','moatads.com','amazon-adsystem','tanx.com','mediav.com','miaozhen.com','ipinyou.com','adsame','admaster','adview.cn','allyes.com','adchina.com'];
const AD_PATH_PATTERN = /(^|\\/)(ads?|adverts?|advertising|adcreative|adplayer|adframe|bannerads?|popunder|interstitial|preroll|midroll|postroll)(\\/|$)/i;
const LEARNED_AD_HOSTS_KEY = 'learnedAdHosts'; const PLAYLIST_MARKER_STATS_KEY = 'playlistMarkerStats';
const rawPlaylistCache = new Map(); const RAW_PLAYLIST_CACHE_MAX = 4;
let lastRawPlaylist = null; let lastRemovedSegmentIds = new Set();
`;

const publicSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_artplayer_handler.js'), 'utf8');
const locatorSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_ad_locator.js'), 'utf8')
    .replace('})(window);', '})(globalThis);');
const PUBLIC_FNS = [
    'isDiscontinuityLine', 'splitPlaylistBlocks', 'playlistHost', 'playlistPathPrefix',
    'isAdSegmentUri', 'getLearnedAdHosts', 'rememberAdHosts', 'recordAdFilterStats',
    'filterByHostRules', 'isAdStartTag', 'isAdEndTag', 'filterByStructure',
    'findAdBlockIndexes', 'filterAdsFromM3U8', 'finishFiltering', 'computeRemovedSegmentIds',
    'parseRawPlaylist', 'segmentIdentity', 'playlistCacheKey', 'getRawPlaylist',
    'rememberRawPlaylist',
];
const publicCtx = makeSandbox();
vm.runInContext(PRELUDE + locatorSrc + '\n' + extractFunctions(publicSrc, PUBLIC_FNS) +
    '\nglobalThis.__api = { filterAdsFromM3U8, splitPlaylistBlocks, playlistHost, localStorage };', publicCtx);

const rootSrc = fs.readFileSync(path.join(process.cwd(), 'js/player.js'), 'utf8');
// 根版单文件没有 finishFiltering（无播放时间轴换算），函数集与 public 版不同
const ROOT_FNS = [
    'isDiscontinuityLine', 'splitPlaylistBlocks', 'playlistHost', 'playlistPathPrefix',
    'isAdSegmentUri', 'getLearnedAdHosts', 'rememberAdHosts', 'recordAdFilterStats',
    'filterByHostRules', 'isAdStartTag', 'isAdEndTag', 'filterByStructure',
    'findAdBlockIndexes', 'findAdBlockCandidates', 'adBlockIsUniformDuration',
    'adBlockSinglePrefix', 'filterAdsFromM3U8',
];
const rootCtx = makeSandbox();
vm.runInContext(PRELUDE + extractConsts(rootSrc, '^const AD_LOCATOR_[A-Z_]+ = [^;]+;') + '\n' +
    extractFunctions(rootSrc, ROOT_FNS) +
    '\nglobalThis.__api = { filterAdsFromM3U8, splitPlaylistBlocks, playlistHost, localStorage };', rootCtx);

const publicApi = publicCtx.__api;
const rootApi = rootCtx.__api;

// ---------- 构造器 ----------
// id 段在每块内独立编号（全局递增会让「同一组广告分片复用」的场景失效）
function build(spec) {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10'];
    spec.forEach(b => {
        if (b.discontinuity) lines.push('#EXT-X-DISCONTINUITY');
        if (b.keyNone) lines.push('#EXT-X-KEY:METHOD=NONE');
        else if (b.key) lines.push('#EXT-X-KEY:METHOD=AES-128,URI="key.key"');
        for (let i = 0; i < b.n; i++) {
            const d = Array.isArray(b.durs) ? b.durs[i] : b.dur;
            lines.push(`#EXTINF:${d},`);
            lines.push(`${b.prefix}${b.id || 'seg'}${i}.ts`);
        }
    });
    lines.push('#EXT-X-ENDLIST');
    return lines.join('\n');
}

// ---------- 场景库 ----------
// expect: 要删的块下标（'none' = 一块都不该删）
const CASES = [
    {
        name: '标准插播广告：独立域名 + KEY_NONE + 独立目录 + 时长规整',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: false, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
            { discontinuity: true, keyNone: true, prefix: 'https://ads.vendor.net/spot/hls/', n: 4, dur: 5 },
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
        ],
        expect: [1],
    },
    {
        name: '广告与正片同域名同目录（采集站常见，只靠 KEY_NONE 区分）',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: false, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
            { discontinuity: true, keyNone: true, prefix: 'https://cdn.example.com/movie/hls/', n: 4, dur: 5 },
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
        ],
        // 严判据的安全阀：同前缀出现在多个块里时，分片集合必须一致才认。
        // 同目录的正片块分片集合不同 → 放弃判定（宁可漏删，不能误删正片）。
        expect: 'none',
    },
    {
        name: '异域名但无 KEY_NONE（源站未加密）',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: false, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
            { discontinuity: true, keyNone: false, prefix: 'https://ads.vendor.net/spot/hls/', n: 4, dur: 5 },
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
        ],
        // 域名不含已知广告特征词、路径也不含广告词段 → 主机特征法不认；
        // 没有 KEY_NONE → 结构法也不认。宁可漏删，不能误删。
        expect: 'none',
    },
    {
        name: '源站固定切片：同域名 + 每块都短 + 大量断点 + 全片不加密',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: true, keyNone: true, prefix: 'https://cdn.example.com/movie/hls/', n: 5, dur: 5 },
            { discontinuity: true, keyNone: true, prefix: 'https://cdn.example.com/movie/hls/', n: 5, dur: 5 },
            { discontinuity: true, keyNone: true, prefix: 'https://cdn.example.com/movie/hls/', n: 5, dur: 5 },
        ],
        expect: 'none',
    },
    {
        name: '正片切成多个短块（每块 42s，总时长很长）',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: false, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 100, dur: 6 },
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 7, dur: 6 },
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 7, dur: 6 },
        ],
        expect: 'none',
    },
    {
        name: '误伤路径①：短正片头 + 长正片主体 + 尾块真广告',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 4, dur: 5 },
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 67, dur: 6 },
            { discontinuity: true, keyNone: true, prefix: 'https://ads.vendor.net/spot/hls/', n: 5, dur: 5 },
        ],
        // 第一项带断点 → 清单开头会多出一个空块，广告块的索引是 3
        expect: [3],
    },
    {
        name: '误伤路径②：全片不加密 + 短块切片（KEY_NONE 判据对每块都成立）',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: true, keyNone: true, prefix: 'https://cdn.example.com/movie/hls/', n: 5, dur: 5 },
            { discontinuity: true, keyNone: true, prefix: 'https://cdn.example.com/movie/hls/', n: 5, dur: 5 },
            { discontinuity: true, keyNone: true, prefix: 'https://cdn.example.com/movie/hls/', n: 5, dur: 5 },
        ],
        expect: 'none',
    },
    {
        name: '广告块时长规整但超过 300s（长广告组）',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: false, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
            { discontinuity: true, keyNone: true, prefix: 'https://ads.vendor.net/spot/hls/', n: 61, dur: 5 },
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
        ],
        expect: 'none',
    },
    {
        name: '广告块分片数超过 40（长广告组）',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: false, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
            { discontinuity: true, keyNone: true, prefix: 'https://ads.vendor.net/spot/hls/', n: 41, dur: 5 },
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
        ],
        expect: 'none',
    },
    {
        name: '广告块时长不规整（正片被切成不规则片段，不该当广告删）',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: false, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
            { discontinuity: true, keyNone: true, prefix: 'https://cdn.example.com/movie/hls/', n: 4, dur: 5 },
        ],
        expect: 'none',
    },
    {
        name: '片头贴片：第 0 块独占目录 + KEY_NONE + 规整时长',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: false, keyNone: true, prefix: 'https://ads.vendor.net/preroll/hls/', n: 4, dur: 5 },
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
        ],
        expect: [0],
    },
    {
        name: '片头贴片：第 0 块与正片同目录（不独占 → 不该删）',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: false, keyNone: true, prefix: 'https://cdn.example.com/movie/hls/', n: 4, dur: 5 },
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 200, dur: 6 },
        ],
        expect: 'none',
    },
    {
        name: '广告块占全片时长 40%（超过 30% 兜底 → 整体放弃）',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: false, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 10, dur: 6 },
            { discontinuity: true, keyNone: true, prefix: 'https://ads.vendor.net/spot/hls/', n: 16, dur: 5 },
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 10, dur: 6 },
        ],
        // 广告 80s / 总 200s = 40%，超过 30% 兜底线 → 放弃删除
        expect: 'none',
    },
    {
        name: '同前缀多分片且集合不一致（正片普通分块，不该当广告）',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: false, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 100, dur: 6 },
            { discontinuity: true, keyNone: true, prefix: 'https://ads.vendor.net/spot/hls/', n: 4, dur: 5 },
            { discontinuity: true, keyNone: true, prefix: 'https://ads.vendor.net/spot/hls/', n: 4, dur: 5, id: 'other' },
        ],
        expect: 'none',
    },
    {
        name: '同一组广告分片在片头片尾各插一次（应全删）',
        base: 'https://cdn.example.com/movie/hls/index.m3u8',
        spec: [
            { discontinuity: false, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 100, dur: 6 },
            { discontinuity: true, keyNone: true, prefix: 'https://ads.vendor.net/spot/hls/', n: 4, dur: 5, id: 'ad' },
            { discontinuity: true, key: true, prefix: 'https://cdn.example.com/movie/hls/', n: 100, dur: 6 },
            { discontinuity: true, keyNone: true, prefix: 'https://ads.vendor.net/spot/hls/', n: 4, dur: 5, id: 'ad' },
        ],
        expect: [1, 3],
    },
    {
        // 实测 ikun 源（2026-11-05 采集）的真实广告形态：pod 里混一条偏长创意
        // [3,3,5,3,3,0.64]，旧判据只豁免偏短残片 → 三处插入全部漏删
        name: '长创意广告 pod（ikun 实测形态）：偏长创意 + 偏短残片，三处插入复用同组分片',
        base: 'https://kkzycdn.com:65/20260831/maindir/2229kb/hls/index.m3u8',
        spec: [
            { discontinuity: false, prefix: 'https://kkzycdn.com:65/20260831/maindir/2229kb/hls/', n: 68, dur: 3 },
            { discontinuity: true, keyNone: true, prefix: 'https://kkzycdn.com:65/20261102/adpod/10082kb/hls/', n: 6, durs: [3, 3, 5, 3, 3, 0.64], id: 'ad' },
            { discontinuity: true, prefix: 'https://kkzycdn.com:65/20260831/maindir/2229kb/hls/', n: 561, dur: 3 },
            { discontinuity: true, keyNone: true, prefix: 'https://kkzycdn.com:65/20261102/adpod/10082kb/hls/', n: 6, durs: [3, 3, 5, 3, 3, 0.64], id: 'ad' },
            { discontinuity: true, prefix: 'https://kkzycdn.com:65/20260831/maindir/2229kb/hls/', n: 208, dur: 3 },
            { discontinuity: true, keyNone: true, prefix: 'https://kkzycdn.com:65/20261102/adpod/10082kb/hls/', n: 6, durs: [3, 3, 5, 3, 3, 0.64], id: 'ad' },
        ],
        expect: [1, 3, 5],
    },
    {
        // 守卫：长创意豁免有上限（≤2.5×众数），超限的不规整块仍然不动
        name: '长创意超上限（10s > 2.5×3s）→ 不规整，宁漏勿误',
        base: 'https://kkzycdn.com:65/20260831/maindir/2229kb/hls/index.m3u8',
        spec: [
            { discontinuity: false, prefix: 'https://kkzycdn.com:65/20260831/maindir/2229kb/hls/', n: 200, dur: 3 },
            { discontinuity: true, keyNone: true, prefix: 'https://kkzycdn.com:65/20261102/adpod/10082kb/hls/', n: 6, durs: [3, 3, 10, 3, 3, 0.64], id: 'ad' },
        ],
        expect: 'none',
    },
];

function runCase(api, c) {
    api.localStorage.__reset();
    const text = build(c.spec);
    const filtered = api.filterAdsFromM3U8(text, true, c.base);
    const before = api.splitPlaylistBlocks(text.split('\n'));
    const keptUris = [];
    filtered.split('\n').forEach(l => { const t = l.trim(); if (t && t.charAt(0) !== '#') keptUris.push(t); });
    const removed = [];
    before.forEach((b, i) => {
        if (b.segments.length && !b.segments.every(u => keptUris.includes(u.uri))) removed.push(i);
    });
    const totalDur = before.reduce((n, b) => n + b.duration, 0);
    const removedDur = removed.reduce((n, i) => n + before[i].duration, 0);
    return { removed, totalDur, removedDur, ratio: totalDur > 0 ? removedDur / totalDur : 0, before };
}

console.log('\n=== 压力测试：边界场景（两版同时验证）===\n');
let pass = 0, fail = 0;
const mismatches = [];
CASES.forEach(c => {
    const p = runCase(publicApi, c);
    const r = runCase(rootApi, c);
    const expect = c.expect === 'none' ? [] : c.expect;
    const pOk = p.removed.join(',') === expect.join(',');
    const rOk = r.removed.join(',') === expect.join(',');
    const same = p.removed.join(',') === r.removed.join(',');
    if (!same) mismatches.push(c.name);
    const ok = pOk && rOk && same;
    ok ? pass++ : fail++;
    const mark = ok ? '✅' : '❌';
    console.log(`${mark} 【${c.name}】`);
    console.log(`   期望删除 [${expect.join(',') || '无'}]｜public 实得 [${p.removed.join(',') || '无'}]｜根版实得 [${r.removed.join(',') || '无'}]`);
    if (!ok) {
        console.log(`   ⚠️ public ${pOk ? '符合' : '不符'} / 根版 ${rOk ? '符合' : '不符'}${same ? '' : ' / 两版不一致'}`);
        p.removed.forEach(i => {
            const b = p.before[i];
            const hosts = [...new Set(b.segments.map(s => publicApi.playlistHost(s.uri, c.base)))];
            console.log(`     删除块${i}: ${b.segments.length}片/${b.duration.toFixed(0)}s host=${hosts.join(',')} 断点=${b.discontinuity}`);
        });
    }
    console.log('');
});
console.log(`=== 压力测试汇总：通过 ${pass} / 失败 ${fail} ===`);
console.log(mismatches.length ? `两版不一致的场景：${mismatches.join('、')}` : '两版行为完全一致');
process.exit(fail > 0 ? 1 : 0);
