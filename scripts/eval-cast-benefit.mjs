// 投屏端广告过滤收益评估
//
// 回答三个问题：
//   1. 投屏链路现在到底有没有广告？（机制确认）
//   2. 有广告的站源占比多少？单集能省多少时间？
//   3. 改造要动多少代码？维护成本多大？
//
// 数据来自真实站源清单样本（40 个），用与前端完全相同的严判据判定。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SAMPLES = process.argv[2] || path.join(process.cwd(), 'samples');
const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'manifest.json'), 'utf8'));

// ---------------- 载入前端严判据（保证与实际行为一致）----------------
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
const LEARNED_AD_HOSTS_KEY = 'learnedAdHosts';
const rawPlaylistCache = new Map(); const RAW_PLAYLIST_CACHE_MAX = 4;
const removedSegmentsByPlaylist = new Map(); // 分键的「被删分片名单」（与 handler 内同名常量一致）
let lastRawPlaylist = null; let lastRemovedSegmentIds = new Set();
`;
const sandbox = {
    window: {}, console, URL, Date, Set, Map, Math, JSON, parseFloat, Object, Array, Number, String, RegExp, isNaN,
    localStorage: { _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k]; }, setItem(k, v) { this._d[k] = String(v); } },
};
sandbox.globalThis = sandbox;
sandbox.window = sandbox;
const ctx = vm.createContext(sandbox);
vm.runInContext(PRELUDE + locatorSrc + '\n' +
    extractFunctions(handlerSrc, ['isDiscontinuityLine', 'splitPlaylistBlocks', 'playlistPathPrefix',
        'findAdBlockIndexes']) +
    '\nglobalThis.__api = { findAdBlockIndexes, splitPlaylistBlocks };', ctx);
const api = sandbox.__api;

// ---------------- 统计 ----------------
const perSite = new Map();
let totalSamples = 0;
let samplesWithAd = 0;
let totalAdSeconds = 0;
let totalContentSeconds = 0;
const details = [];

manifest.forEach(item => {
    const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
    const blocks = api.splitPlaylistBlocks(text.split('\n'));
    const adIndexes = api.findAdBlockIndexes(blocks);
    const totalDur = blocks.reduce((n, b) => n + b.duration, 0);
    const adDur = adIndexes.reduce((n, i) => n + blocks[i].duration, 0);

    totalSamples++;
    totalContentSeconds += totalDur;
    if (adIndexes.length) {
        samplesWithAd++;
        totalAdSeconds += adDur;
    }
    const s = perSite.get(item.site) || { n: 0, withAd: 0, adSec: 0, contentSec: 0 };
    s.n++;
    s.contentSec += totalDur;
    if (adIndexes.length) { s.withAd++; s.adSec += adDur; }
    perSite.set(item.site, s);

    details.push({
        site: item.site, keyword: item.keyword,
        blocks: blocks.length, totalDur: Math.round(totalDur),
        adBlocks: adIndexes.length, adDur: Math.round(adDur),
        adRatio: totalDur > 0 ? adDur / totalDur : 0,
    });
});

console.log('\n=== 投屏端广告过滤收益评估 ===\n');
console.log(`样本总数：${totalSamples} 个真实清单（${perSite.size} 个站源）`);
console.log(`含广告的清单：${samplesWithAd} 个（${(samplesWithAd / totalSamples * 100).toFixed(1)}%）`);
console.log(`单集平均可省：${(totalAdSeconds / totalSamples).toFixed(1)} 秒`);
console.log(`总样本可省：${(totalAdSeconds / 60).toFixed(1)} 分钟（共 ${Math.round(totalContentSeconds / 60)} 分钟内容）`);

console.log('\n=== 分站源 ===');
console.log('站源      样本数  含广告  广告时长   内容时长   广告占比');
[...perSite.entries()].forEach(([site, s]) => {
    const ratio = s.contentSec > 0 ? s.adSec / s.contentSec * 100 : 0;
    console.log([
        site.padEnd(9), String(s.n).padStart(5), String(s.withAd).padStart(7),
        (s.adSec.toFixed(0) + 's').padStart(9), (s.contentSec.toFixed(0) + 's').padStart(11),
        (ratio.toFixed(2) + '%').padStart(9),
    ].join(' '));
});

console.log('\n=== 含广告的样本明细 ===');
details.filter(d => d.adBlocks > 0).forEach(d => {
    console.log(`  [${d.site}] ${d.keyword}：${d.adBlocks} 块广告 / ${d.adDur}s（全片 ${d.totalDur}s，占 ${(d.adRatio * 100).toFixed(2)}%）`);
});

console.log('\n=== 投屏链路机制确认 ===');
console.log('· proxy 模式：rewrite_playlist() 只改写地址、不做过滤 → 电视端拿到的是未过滤清单');
console.log('· proxy-ts 模式：parse_media_playlist() 逐片拼接 TS，同样不做过滤');
console.log('· direct 模式：电视直连源站，App 完全无法介入');
console.log('→ 结论：投屏端目前 100% 会显示广告，且三种模式都无例外');

console.log('\n=== 改造成本 ===');
console.log('· 需要在 Rust 侧独立实现一份与 JS 等价的判据（无 url crate，需自解析 host + 路径前缀）');
console.log('· 两套实现存在漂移风险：JS 改了判据，Rust 侧不会自动同步');
console.log('· 需覆盖 proxy（rewrite_playlist）与 proxy-ts（parse_media_playlist）两条路径');
console.log('· direct 模式无法覆盖（App 不在链路中）');
