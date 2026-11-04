// 广告过滤端到端实测：调用真实的 filterAdsFromM3U8(text, true, baseUrl)，
// 再与原始清单比对，算出实际被删掉的分片，然后逐块人工核验是广告还是误伤。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SAMPLES = process.argv[2] || '/tmp/plsamples';
const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'manifest.json'), 'utf8'));
const handlerSrc = fs.readFileSync(
  path.join(process.cwd(), 'public/js/player_artplayer_handler.js'), 'utf8');

function extractFunction(name) {
  const start = handlerSrc.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数 ' + name);
  let depth = 0;
  let i = handlerSrc.indexOf('{', start);
  for (; i < handlerSrc.length; i++) {
    const ch = handlerSrc[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return handlerSrc.slice(start, i);
}

const sandbox = {
  window: {}, console, URL, Date, Set, Map, Math, JSON, parseFloat,
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
  },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

const NEEDED = [
  'isDiscontinuityLine', 'splitPlaylistBlocks', 'playlistHost', 'isAdSegmentUri',
  'getLearnedAdHosts', 'rememberAdHosts', 'recordAdFilterStats', 'filterByHostRules',
  'isAdStartTag', 'isAdEndTag', 'filterByStructure', 'filterAdsFromM3U8',
  'parseRawPlaylist', 'playlistPathPrefix', 'segmentIdentity', 'computeRemovedSegmentIds',
  'finishFiltering', 'getRawPlaylist', 'rememberRawPlaylist', 'playlistCacheKey',
  'segmentIdentity',
];
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
vm.runInContext(PRELUDE + NEEDED.map(extractFunction).join('\n\n') +
  '\nglobalThis.__api = { filterAdsFromM3U8, filterByStructure, filterByHostRules, splitPlaylistBlocks, playlistHost, parseRawPlaylist, computeRemovedSegmentIds };', ctx);
const api = sandbox.__api;

// ---------- 核验模型 ----------
// 规则：广告块 = 独立路径前缀 + KEY:NONE + 时长规整 + 与正片无共享分片
// 先算「正片主体」：不含 DISCONTINUITY+KEY:NONE 组合的块，或占时长最多的前缀
function classify(text, baseUrl) {
  const blocks = api.splitPlaylistBlocks(text.split('\n'));
  const info = blocks.map((b, i) => {
    const prefixes = [...new Set(b.segments.map(s => {
      try { const u = new URL(s.uri, baseUrl); return u.host + u.pathname.replace(/[^/]*$/, ''); } catch (e) { return ''; }
    }))];
    const keyNone = b.lines.some(l => l.trim().indexOf('#EXT-X-KEY:METHOD=NONE') === 0);
    const durs = b.segments.map(s => Math.round(s.duration * 10) / 10);
    const counts = new Map();
    durs.forEach(d => counts.set(d, (counts.get(d) || 0) + 1));
    const mode = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const uniform = counts.size <= 2 && mode && mode[1] >= Math.ceil(durs.length / 2);
    return {
      index: i, discontinuity: b.discontinuity, keyNone,
      segCount: b.segments.length, duration: b.duration,
      prefixes, uniform,
      uris: b.segments.map(s => s.uri),
      lines: b.lines,
    };
  });
  // 正片分片集合：所有块的 URI 合起来（用于判断共享）
  // 逐块判定：块是否广告
  return info.map(b => {
    const signals = [];
    if (!b.discontinuity) signals.push('无断点');
    if (!b.keyNone) signals.push('无KEY_NONE');
    if (b.prefixes.length !== 1) signals.push(`多前缀(${b.prefixes.length})`);
    if (!b.uniform) signals.push('时长不规整');
    if (b.duration > 300) signals.push('超300s');
    if (b.segCount > 40) signals.push('超40片');
    return {
      ...b,
      isAd: signals.length === 0,
      signals,
    };
  });
}

// ---------- 端到端跑 ----------
const report = [];
for (const item of manifest) {
  const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
  const baseUrl = item.url;

  const before = classify(text, baseUrl);
  const filtered = api.filterAdsFromM3U8(text, true, baseUrl);
  const after = classify(filtered, baseUrl);

  // 实际被删掉的块：用 URI 集合差集对齐（贪心，广告整块删，顺序不乱）
  const keptUris = [];
  filtered.split('\n').forEach(l => { const t = l.trim(); if (t && t.charAt(0) !== '#') keptUris.push(t); });
  const removedBlocks = [];
  let ki = 0;
  before.forEach(b => {
    const allKept = b.uris.every(u => keptUris.includes(u));
    if (!allKept) removedBlocks.push(b);
  });

  const totalSeg = before.reduce((n, b) => n + b.segCount, 0);
  const totalDur = before.reduce((n, b) => n + b.duration, 0);
  const removedDur = removedBlocks.reduce((n, b) => n + b.duration, 0);
  const removedSeg = removedBlocks.reduce((n, b) => n + b.segCount, 0);

  const falsePos = removedBlocks.filter(b => !b.isAd);
  const truePos = removedBlocks.filter(b => b.isAd);
  const falseNeg = before.filter(b => b.isAd && !removedBlocks.includes(b));

  report.push({
    site: item.site, keyword: item.keyword, url: item.url,
    totalBlocks: before.length, totalSeg, totalDur: Math.round(totalDur),
    removedBlocks: removedBlocks.length,
    removedSeg, removedDur: Math.round(removedDur),
    removedRatio: totalDur > 0 ? +(removedDur / totalDur).toFixed(4) : 0,
    tp: truePos.length, fp: falsePos.length, fn: falseNeg.length,
    detail: removedBlocks.map(b => ({
      idx: b.index, segs: b.segCount, dur: Math.round(b.duration),
      prefix: b.prefixes.join(','), signals: b.signals.join('/') || '全信号命中',
      verdict: b.isAd ? '广告' : '误伤',
    })),
    fnDetail: falseNeg.map(b => ({
      idx: b.index, segs: b.segCount, dur: Math.round(b.duration),
      prefix: b.prefixes.join(','), signals: b.signals.join('/'),
    })),
  });
}

console.log('\n=== 端到端实测：真实调用 filterAdsFromM3U8(text, true, base) ===\n');
console.log('站点      块数  分片   总时长   删除块  删除时长  删除占比  广告  误伤  漏删');
for (const r of report) {
  console.log([
    r.site.padEnd(8), String(r.totalBlocks).padStart(4), String(r.totalSeg).padStart(6),
    (r.totalDur + 's').padStart(8), String(r.removedBlocks).padStart(7),
    (r.removedDur + 's').padStart(9), ((r.removedRatio * 100).toFixed(2) + '%').padStart(8),
    String(r.tp).padStart(4), String(r.fp).padStart(4), String(r.fn).padStart(4),
  ].join(' '));
}
console.log('\n=== 有删除动作的样本明细 ===');
for (const r of report.filter(x => x.removedBlocks > 0)) {
  console.log(`\n[${r.site}] ${r.keyword}  ${r.url}`);
  console.log(`   总 ${r.totalBlocks} 块 / ${r.totalSeg} 片 / ${r.totalDur}s，删除 ${r.removedBlocks} 块 = ${r.removedDur}s (${(r.removedRatio * 100).toFixed(2)}%)`);
  r.detail.forEach(d => console.log(`     -块${d.idx}: ${d.segs}片/${d.dur}s 前缀=${d.prefix} 信号=${d.signals} → ${d.verdict}`));
  if (r.fnDetail.length) {
    console.log('   漏删的疑似广告块：');
    r.fnDetail.forEach(d => console.log(`     -块${d.idx}: ${d.segs}片/${d.dur}s 前缀=${d.prefix} 缺信号=${d.signals}`));
  }
}

const agg = report.reduce((a, r) => ({ tp: a.tp + r.tp, fp: a.fp + r.fp, fn: a.fn + r.fn }), { tp: 0, fp: 0, fn: 0 });
console.log('\n=== 汇总 ===');
console.log(`样本 ${report.length} 个，实际删除 ${report.reduce((n, r) => n + r.removedBlocks, 0)} 块`);
console.log(`正确识别广告 ${agg.tp} 块 / 误伤 ${agg.fp} 块 / 漏删 ${agg.fn} 块`);
console.log(`精确率 ${agg.tp + agg.fp > 0 ? (agg.tp / (agg.tp + agg.fp) * 100).toFixed(1) : 'N/A'}%`);
const fpSites = [...new Set(report.filter(r => r.fp > 0).map(r => r.site))];
console.log(fpSites.length ? `误伤站点：${fpSites.join(', ')}` : '零误伤');

fs.writeFileSync(path.join(SAMPLES, 'e2e-report.json'), JSON.stringify(report, null, 2), 'utf8');
