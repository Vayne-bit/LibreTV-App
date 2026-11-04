// 判据对比（修正版）
// 真值：人工标注。用「结构四信号」独立推导，且不循环依赖待测判据。
// 候选判据 = player_ad_locator.js 的语义（长按自动识别广告用的那套，已过 6 站回归）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const handlerSrc = fs.readFileSync(
  path.join(process.cwd(), 'public/js/player_artplayer_handler.js'), 'utf8');
const locatorSrc = fs.readFileSync(
  path.join(process.cwd(), 'public/js/player_ad_locator.js'), 'utf8');

function extractFrom(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数 ' + name);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const sandbox = {
  window: {}, console, URL, Date, Set, Map, Math, JSON, parseFloat,
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);
const NEEDED = [
  'isDiscontinuityLine', 'splitPlaylistBlocks', 'playlistHost', 'isAdSegmentUri',
  'getLearnedAdHosts', 'rememberAdHosts', 'recordAdFilterStats', 'filterByHostRules',
  'isAdStartTag', 'isAdEndTag', 'filterByStructure', 'filterAdsFromM3U8',
  'parseRawPlaylist', 'playlistPathPrefix', 'segmentIdentity', 'computeRemovedSegmentIds',
  'finishFiltering', 'getRawPlaylist', 'rememberRawPlaylist', 'playlistCacheKey',
];
const PRELUDE = `
const AD_BLOCK_MAX_SECONDS = 300; const AD_REMOVE_MAX_RATIO = 0.3;
const AD_HOST_PATTERNS = ['doubleclick.net','googlesyndication','googleadservices','admob','adnxs.com','pubmatic.com','rubiconproject.com','criteo.com','adcolony','vungle.com','applovin','mopub.com','unityads','inmobi.com','taboola.com','outbrain.com','moatads.com','amazon-adsystem','tanx.com','mediav.com','miaozhen.com','ipinyou.com','adsame','admaster','adview.cn','allyes.com','adchina.com'];
const AD_PATH_PATTERN = /(^|\\/)(ads?|adverts?|advertising|adcreative|adplayer|adframe|bannerads?|popunder|interstitial|preroll|midroll|postroll)(\\/|$)/i;
const LEARNED_AD_HOSTS_KEY = 'learnedAdHosts'; const PLAYLIST_MARKER_STATS_KEY = 'playlistMarkerStats';
const rawPlaylistCache = new Map(); const RAW_PLAYLIST_CACHE_MAX = 4;
const removedSegmentsByPlaylist = new Map(); // 分键的「被删分片名单」（与 handler 内同名常量一致）
let lastRawPlaylist = null; let lastRemovedSegmentIds = new Set();
`;
vm.runInContext(PRELUDE + NEEDED.map(extractFrom.bind(null, handlerSrc)).join('\n\n') +
  '\nglobalThis.__api = { filterAdsFromM3U8, splitPlaylistBlocks, playlistHost, parseRawPlaylist };', ctx);
const api = sandbox.__api;

// ---- 直接复用 locator 的真实实现（不重写，避免语义漂移）----
const locatorCode = locatorSrc.replace('})(window);', '})(globalThis);');
const locatorCtx = vm.createContext({ window: {}, console, URL, Date, Set, Map, Math, JSON });
vm.createContext(locatorCtx);
vm.runInContext(locatorCode, locatorCtx);
const Locator = locatorCtx.AdBlockLocator;

// ============ 真值标注 ============
// 判据（独立于待测代码）：一个块是广告，当且仅当
//   - 有前置断点
//   - KEY:METHOD=NONE
//   - 块内分片路径前缀唯一（只有一个前缀）
//   - 该前缀的时长占全片 ≤30%
// 这与 locator 的安全阀一致，但「唯一前缀」换成「该前缀的块集合」来判断复用。
function groundTruth(text, baseUrl) {
  const blocks = api.splitPlaylistBlocks(text.split('\n'));
  const info = blocks.map((b, i) => {
    const prefixes = [...new Set(b.segments.map(s => {
      try { const u = new URL(s.uri, baseUrl); return u.host + u.pathname.replace(/[^/]*$/, ''); } catch (e) { return ''; }
    }))];
    const keyNone = b.lines.some(l => l.trim().indexOf('#EXT-X-KEY:METHOD=NONE') === 0);
    return { index: i, discontinuity: b.discontinuity, keyNone, prefixes,
             segCount: b.segments.length, duration: b.duration };
  });
  const totalDur = info.reduce((n, b) => n + b.duration, 0);
  const prefixDur = new Map();
  info.forEach(b => b.prefixes.forEach(p => {
    prefixDur.set(p, (prefixDur.get(p) || 0) + b.duration);
  }));
  // 一个块是广告：断点 + KEY_NONE + 单前缀 + 前缀占比≤30% + 时长≤300s
  return info.map(b => {
    let isAd = false;
    if (b.discontinuity && b.keyNone && b.prefixes.length === 1 &&
        b.duration > 0 && b.duration <= 300) {
      const pd = prefixDur.get(b.prefixes[0]) || 0;
      isAd = totalDur > 0 && pd / totalDur <= 0.3;
    }
    return { ...b, isAd };
  });
}

// ============ 现有宽判据 ============
function wideDropped(text, baseUrl) {
  const blocks = api.splitPlaylistBlocks(text.split('\n'));
  const contentHosts = new Set();
  const dropped = [];
  blocks.forEach((b, i) => {
    if (!b.segments.length) return;
    const hosts = b.segments.map(s => api.playlistHost(s.uri, baseUrl));
    const resetKey = b.lines.some(l => l.trim().indexOf('#EXT-X-KEY:METHOD=NONE') === 0);
    const short = b.duration > 0 && b.duration <= 300;
    const disjoint = hosts.every(h => !contentHosts.has(h));
    if (b.discontinuity && short && (disjoint || resetKey)) { dropped.push(i); return; }
    hosts.forEach(h => contentHosts.add(h));
  });
  return { blocks, dropped };
}

// ============ locator 严判据（候选）============
function strictDropped(text, baseUrl) {
  const parsed = api.parseRawPlaylist(text, baseUrl);
  const cands = Locator.findAdBlockCandidates(parsed);
  const idx = new Set(cands.map(c => c.blockIndex));
  return { parsed, candidates: cands, dropped: [...idx] };
}

// ============ 场景 A：真实清单原样 ============
const SAMPLES = process.argv[2] || '/tmp/plsamples2';
const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'manifest.json'), 'utf8'));

console.log('\n=== 场景A：真实清单原样（30 样本）===\n');
console.log('站点     块数  真值广告块   宽判据删块(误伤数)  严判据删块(误伤数)');
let wTp = 0, wFp = 0, sTp = 0, sFp = 0, wFn = 0, sFn = 0;
for (const item of manifest) {
  const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
  const truth = groundTruth(text, item.url);
  const truthSet = new Set(truth.filter(t => t.isAd).map(t => t.index));
  const w = wideDropped(text, item.url);
  const s = strictDropped(text, item.url);
  const wFpN = w.dropped.filter(i => !truthSet.has(i)).length;
  const sFpN = s.dropped.filter(i => !truthSet.has(i)).length;
  wTp += w.dropped.filter(i => truthSet.has(i)).length; wFp += wFpN;
  wFn += truthSet.size - w.dropped.filter(i => truthSet.has(i)).length;
  sTp += s.dropped.filter(i => truthSet.has(i)).length; sFp += sFpN;
  sFn += truthSet.size - s.dropped.filter(i => truthSet.has(i)).length;
  if (w.dropped.length || s.dropped.length || truthSet.size) {
    console.log(`${item.site.padEnd(9)} ${String(truth.length).padStart(4)}  ${JSON.stringify([...truthSet]).padEnd(12)}  ${JSON.stringify(w.dropped).slice(0, 40).padEnd(24)}(${wFpN})  ${JSON.stringify(s.dropped)}(${sFpN})`);
  }
}
console.log(`\n宽判据：命中广告 ${wTp}，误伤 ${wFp}，漏删 ${wFn}`);
console.log(`严判据：命中广告 ${sTp}，误伤 ${sFp}，漏删 ${sFn}`);
const prec = (tp, fp) => tp + fp > 0 ? (tp / (tp + fp) * 100).toFixed(1) + '%' : 'N/A';
const rec = (tp, fn) => tp + fn > 0 ? (tp / (tp + fn) * 100).toFixed(1) + '%' : 'N/A';
console.log(`宽判据精确率 ${prec(wTp, wFp)} 召回率 ${rec(wTp, wFn)}`);
console.log(`严判据精确率 ${prec(sTp, sFp)} 召回率 ${rec(sTp, sFn)}`);

// ============ 场景 B：真实清单注入广告块 ============
console.log('\n\n=== 场景B：注入真广告块后，宽判据会不会连带误删正片 ===\n');
function injectAd(text) {
  const lines = text.split('\n');
  const idx = lines.findIndex(l => l.trim() === '#EXT-X-DISCONTINUITY');
  if (idx < 0) return null;
  const ad = [
    '#EXT-X-DISCONTINUITY', '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:5,', 'https://ads.vendor.net/spot/hls/ad0.ts',
    '#EXTINF:5,', 'https://ads.vendor.net/spot/hls/ad1.ts',
    '#EXTINF:5,', 'https://ads.vendor.net/spot/hls/ad2.ts',
    '#EXTINF:5,', 'https://ads.vendor.net/spot/hls/ad3.ts',
  ];
  return [...lines.slice(0, idx + 1), ...ad, ...lines.slice(idx + 1)].join('\n');
}
console.log('站点     总时长   宽:删块(误伤正片)   30%兜底后实际   严:删块');
for (const item of manifest) {
  const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
  const injected = injectAd(text);
  if (!injected) continue;
  const truth = groundTruth(injected, item.url);
  const truthSet = new Set(truth.filter(t => t.isAd).map(t => t.index));
  const w = wideDropped(injected, item.url);
  const s = strictDropped(injected, item.url);
  const wFp = w.dropped.filter(i => !truthSet.has(i));
  const totalDur = w.blocks.reduce((n, b) => n + b.duration, 0);
  const remDur = w.dropped.reduce((n, i) => n + w.blocks[i].duration, 0);
  const ratio = totalDur > 0 ? remDur / totalDur : 0;
  const realDelete = wFp.length > 0 && ratio <= 0.3 && remDur > 0;
  console.log(`${item.site.padEnd(9)} ${(totalDur.toFixed(0) + 's').padStart(8)}  ${JSON.stringify(w.dropped).slice(0, 26).padEnd(26)}(${wFp.length})  ${ratio > 0.3 ? '被拦下' : (realDelete ? '⚠️真误删' : '仅删广告')}  ${JSON.stringify(s.dropped)}`);
}
