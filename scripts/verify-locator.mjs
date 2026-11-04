// 验证：player_ad_locator.js 的严判据能否直接替代 filterByStructure 的宽判据。
// 关键要求：
//   1. 真实广告必须命中（不能把已能过滤的广告弄丢）
//   2. 正片必须零误伤
//   3. 对「注入广告」场景仍然有效
//   4. locator 的输入结构要能从 filterByStructure 现有的 blocks 里拿到
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SAMPLES = process.argv[2] || '/tmp/plsamples3';
const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'manifest.json'), 'utf8'));
const handlerSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_artplayer_handler.js'), 'utf8');
const locatorSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_ad_locator.js'), 'utf8');

function ex(src, name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) throw new Error('缺少 ' + name);
  let d = 0, i = src.indexOf('{', s);
  for (; i < src.length; i++) { const c = src[i]; if (c === '{') d++; else if (c === '}') { d--; if (!d) { i++; break; } } }
  return src.slice(s, i);
}

const sb = { window: {}, console, URL, Date, Set, Map, Math, JSON, parseFloat,
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } } };
sb.globalThis = sb;
const ctx = vm.createContext(sb);
const PRELUDE = `
const AD_BLOCK_MAX_SECONDS=300;const AD_REMOVE_MAX_RATIO=0.3;
const AD_HOST_PATTERNS=[];const AD_PATH_PATTERN=/xx/;
const LEARNED_AD_HOSTS_KEY='l';const PLAYLIST_MARKER_STATS_KEY='p';
const rawPlaylistCache=new Map();const RAW_PLAYLIST_CACHE_MAX=4;
let lastRawPlaylist=null;let lastRemovedSegmentIds=new Set();`;
vm.runInContext(PRELUDE + ['isDiscontinuityLine','splitPlaylistBlocks','playlistHost','isAdSegmentUri',
  'getLearnedAdHosts','rememberAdHosts','recordAdFilterStats','filterByHostRules','isAdStartTag','isAdEndTag',
  'filterByStructure','filterAdsFromM3U8','parseRawPlaylist','playlistPathPrefix','segmentIdentity',
  'computeRemovedSegmentIds','finishFiltering','getRawPlaylist','rememberRawPlaylist','playlistCacheKey']
  .map(n => ex(handlerSrc, n)).join('\n') +
  '\nglobalThis.__a={splitPlaylistBlocks,playlistHost,parseRawPlaylist};', ctx);
const A = sb.__a;

// 载入 locator
const locCtx = vm.createContext({ window: {}, console, URL, Date, Set, Map, Math, JSON });
vm.runInContext(locatorSrc.replace('})(window);', '})(globalThis);'), locCtx);
const Locator = locCtx.AdBlockLocator;

// 把 handler 的 blocks 结构转成 locator 需要的 playlist 结构
function toLocatorPlaylist(blocks, baseUrl) {
  const out = blocks.map((b, index) => {
    const segments = b.segments.map(s => {
      let prefix = '';
      try { const u = new URL(s.uri, baseUrl); prefix = u.host + u.pathname.replace(/[^/]*$/, ''); } catch (e) {}
      return { uri: s.uri, duration: s.duration, pathPrefix: prefix };
    });
    const keyNone = b.lines.some(l => l.trim().indexOf('#EXT-X-KEY:METHOD=NONE') === 0);
    return {
      discontinuity: b.discontinuity, keyNone, segments,
      duration: b.segments.reduce((n, s) => n + s.duration, 0)
    };
  });
  return { blocks: out, segments: out.flatMap(b => b.segments), totalDuration: out.reduce((n, b) => n + b.duration, 0) };
}

// 真值：独立判据（不依赖待测实现）
function groundTruth(text, baseUrl) {
  const blocks = A.splitPlaylistBlocks(text.split('\n'));
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
  info.forEach(b => b.prefixes.forEach(p => prefixDur.set(p, (prefixDur.get(p) || 0) + b.duration)));
  return info.map(b => {
    let isAd = false;
    if (b.discontinuity && b.keyNone && b.prefixes.length === 1 && b.duration > 0 && b.duration <= 300) {
      const pd = prefixDur.get(b.prefixes[0]) || 0;
      isAd = totalDur > 0 && pd / totalDur <= 0.3;
    }
    return { ...b, isAd };
  });
}

console.log('\n=== 场景A：真实清单原样 ===\n');
console.log('站点     块数 真值广告块   locator 严判据删块(误伤)');
let tp = 0, fp = 0, fn = 0;
for (const item of manifest) {
  const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
  const blocks = A.splitPlaylistBlocks(text.split('\n'));
  const truth = groundTruth(text, item.url);
  const truthSet = new Set(truth.filter(t => t.isAd).map(t => t.index));
  const playlist = toLocatorPlaylist(blocks, item.url);
  const cands = Locator.findAdBlockCandidates(playlist);
  const idx = cands.map(c => c.blockIndex);
  const fpN = idx.filter(i => !truthSet.has(i)).length;
  tp += idx.filter(i => truthSet.has(i)).length; fp += fpN;
  fn += truthSet.size - idx.filter(i => truthSet.has(i)).length;
  if (idx.length || truthSet.size) {
    console.log(`${item.site.padEnd(9)} ${String(blocks.length).padStart(4)} ${JSON.stringify([...truthSet]).padEnd(12)} ${JSON.stringify(idx)}(${fpN})`);
  }
}
console.log(`\nlocator 严判据：命中 ${tp} / 误伤 ${fp} / 漏删 ${fn}`);
console.log(`精确率 ${tp+fp>0?(tp/(tp+fp)*100).toFixed(1):'N/A'}%  召回率 ${tp+fn>0?(tp/(tp+fn)*100).toFixed(1):'N/A'}%`);

console.log('\n\n=== 场景B：注入真广告块 ===\n');
function injectAd(text) {
  const lines = text.split('\n');
  const idx = lines.findIndex(l => l.trim() === '#EXT-X-DISCONTINUITY');
  if (idx < 0) return null;
  const ad = ['#EXT-X-DISCONTINUITY','#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:5,','https://ads.vendor.net/spot/hls/ad0.ts','#EXTINF:5,','https://ads.vendor.net/spot/hls/ad1.ts',
    '#EXTINF:5,','https://ads.vendor.net/spot/hls/ad2.ts','#EXTINF:5,','https://ads.vendor.net/spot/hls/ad3.ts'];
  return [...lines.slice(0, idx+1), ...ad, ...lines.slice(idx+1)].join('\n');
}
console.log('站点     真值广告块     locator 删块(误伤)');
for (const item of manifest) {
  const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
  const injected = injectAd(text);
  if (!injected) continue;
  const truth = groundTruth(injected, item.url);
  const truthSet = new Set(truth.filter(t => t.isAd).map(t => t.index));
  const blocks = A.splitPlaylistBlocks(injected.split('\n'));
  const cands = Locator.findAdBlockCandidates(toLocatorPlaylist(blocks, item.url));
  const idx = cands.map(c => c.blockIndex);
  const fpN = idx.filter(i => !truthSet.has(i)).length;
  if (idx.length || truthSet.size) {
    console.log(`${item.site.padEnd(9)} ${JSON.stringify([...truthSet]).padEnd(14)} ${JSON.stringify(idx)}(${fpN})`);
  }
}
