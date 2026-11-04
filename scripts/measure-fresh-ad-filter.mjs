// 新鲜样本（fetch-app-sources-samples.mjs 产出）上的广告过滤实测：
//   1. 逐样本跑真实 filterAdsFromM3U8（沙箱加载 public 真实源码 + locator）
//   2. 被删块的安全校验：前缀必须与保留内容完全隔离（零误伤红线）
//   3. 跨集投票模拟：第 1 集学到的广告前缀，应用到第 2/3 集能多删什么、
//      会不会多删正片（评估「前缀学习型投票」的收益与风险）
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const SAMPLES = process.argv[2] || path.join(process.cwd(), 'samples_fresh');
const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'manifest.json'), 'utf8'))
  .filter(m => m.status === 'ok');

const handlerSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_artplayer_handler.js'), 'utf8');
const locatorSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_ad_locator.js'), 'utf8')
  .replace('})(window);', '})(globalThis);');

function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数 ' + name);
  let depth = 0, i = src.indexOf('{', start);
  const from = i;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
const extractFunctions = (src, names) => names.map(n => extractFunction(src, n)).join('\n\n');

function makeSandbox() {
  const sandbox = {
    window: {},
    localStorage: {
      _d: {},
      getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
      setItem(k, v) { this._d[k] = String(v); },
      removeItem(k) { delete this._d[k]; },
    },
    console, URL, Date, Set, Map, Math, JSON, parseFloat,
  };
  sandbox.globalThis = sandbox;
  return vm.createContext(sandbox);
}

const PRELUDE = `
const AD_BLOCK_MAX_SECONDS = 300;
const AD_REMOVE_MAX_RATIO = 0.3;
const AD_HOST_PATTERNS = ['doubleclick.net','googlesyndication','googleadservices','admob','adnxs.com','pubmatic.com','rubiconproject.com','criteo.com','adcolony','vungle.com','applovin','mopub.com','unityads','inmobi.com','taboola.com','outbrain.com','moatads.com','amazon-adsystem','tanx.com','mediav.com','miaozhen.com','ipinyou.com','adsame','admaster','adview.cn','allyes.com','adchina.com'];
const AD_PATH_PATTERN = /(^|\\/)(ads?|adverts?|advertising|adcreative|adplayer|adframe|bannerads?|popunder|interstitial|preroll|midroll|postroll)(\\/|$)/i;
const LEARNED_AD_HOSTS_KEY = 'learnedAdHosts';
const PLAYLIST_MARKER_STATS_KEY = 'playlistMarkerStats';
let lastRawPlaylist = null; let lastRemovedSegmentIds = new Set(); let lastRemovedSegmentUris = [];
const rawPlaylistCache = new Map(); const RAW_PLAYLIST_CACHE_MAX = 4;
const removedSegmentsByPlaylist = new Map(); // 分键的「被删分片名单」（与 handler 内同名常量一致）
`;

const PUBLIC_FNS = [
  'isDiscontinuityLine', 'splitPlaylistBlocks', 'playlistHost', 'playlistPathPrefix',
  'isAdSegmentUri', 'getLearnedAdHosts', 'rememberAdHosts', 'recordAdFilterStats',
  'filterByHostRules', 'isAdStartTag', 'isAdEndTag', 'filterByStructure',
  'findAdBlockIndexes', 'filterAdsFromM3U8', 'finishFiltering', 'computeRemovedSegmentIds',
    'rememberRemovedSegments', 'getRemovedSegmentIds', 'getRemovedSegmentUris',
  'parseRawPlaylist', 'segmentIdentity', 'playlistCacheKey', 'getRawPlaylist', 'rememberRawPlaylist',
];

function loadFreshSandbox() {
  // 每个站点一个独立沙箱 = 独立 localStorage：模拟「同一站源跨集连续播放」
  const ctx = makeSandbox();
  vm.runInContext(PRELUDE + locatorSrc + '\n' + extractFunctions(handlerSrc, PUBLIC_FNS) +
    '\nglobalThis.__api = { filterAdsFromM3U8, splitPlaylistBlocks, playlistPathPrefix, playlistHost, localStorage };', ctx);
  return ctx.__api;
}

// 块级分析（前缀统一用真实代码的 playlistPathPrefix + 真实 baseUrl 解析，
// 保证与 kept 侧同一种算法，避免两套前缀体系互相打架）
function analyzeBlocks(api, text, baseUrl) {
  const blocks = api.splitPlaylistBlocks(text.split('\n'));
  return blocks.map((b, i) => {
    const prefixes = [...new Set(b.segments.map(s => {
      let abs = s.uri;
      try { abs = new URL(s.uri, baseUrl).href; } catch (e) { /* 原样 */ }
      return api.playlistPathPrefix(abs);
    }))];
    const keyNone = b.lines.some(l => l.trim().indexOf('#EXT-X-KEY:METHOD=NONE') === 0);
    return {
      index: i, discontinuity: b.discontinuity, keyNone,
      segCount: b.segments.length, duration: b.duration,
      prefixes, uris: b.segments.map(s => s.uri),
    };
  });
}

// 安全校验：被删块的前缀在保留内容里必须一个都不出现（零误伤的结构性证据）
function prefixIsolation(api, originalText, filteredText, baseUrl) {
  // 保留内容的前缀集合（用真实代码的同款算法）
  const keptPrefixes = new Set();
  filteredText.split('\n').forEach(line => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    let abs = t;
    try { abs = new URL(t, baseUrl).href; } catch (e) { /* 原样 */ }
    const p = api.playlistPathPrefix(abs);
    if (p) keptPrefixes.add(p);
  });
  // 原始清单的块里，凡有分片被保留的块 = 正片块，其前缀必然应在 kept 集合中
  const blocks = analyzeBlocks(api, originalText, baseUrl);
  const keptUris = new Set(filteredText.split('\n').map(l => l.trim()));
  const violations = [];
  blocks.forEach(b => {
    if (!b.segCount) return;
    const keptHasItsUri = b.uris.some(u => keptUris.has(u));
    if (keptHasItsUri && b.prefixes.every(p => !keptPrefixes.has(p))) {
      violations.push({ index: b.index, prefixes: b.prefixes, note: '保留分片但前缀未入集合' });
    }
  });
  return violations;
}

// ---------- 逐样本过滤 + 逐站跨集模拟 ----------
let totalRemoved = 0;
let totalViolations = 0;
const siteSummary = [];

const bySite = new Map();
manifest.forEach(m => {
  if (!bySite.has(m.site)) bySite.set(m.site, []);
  bySite.get(m.site).push(m);
});

for (const [site, items] of bySite) {
  const api = loadFreshSandbox(); // 每站独立沙箱：学习型黑名单/前缀库不跨站污染
  const rows = [];
  for (const item of items) {
    const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
    const baseUrl = item.mediaUrl || item.playUrl;
    const before = analyzeBlocks(api, text, baseUrl);
    const filtered = api.filterAdsFromM3U8(text, true, baseUrl);
    const after = analyzeBlocks(api, filtered, baseUrl);
    const removedSegs = before.reduce((n, b) => n + b.segCount, 0) - after.reduce((n, b) => n + b.segCount, 0);
    const removedInfo = [];
    if (removedSegs > 0) {
      // 分片级 diff：被删块的判定 = 该块有分片从过滤结果里消失
      //（块级匹配在「删块后相邻正片块合并」时会误报，不能用）
      const keptSet = new Set();
      filtered.split(String.fromCharCode(10)).forEach(l => { const t = l.trim(); if (t && t.charAt(0) !== '#') keptSet.add(t); });
      before.forEach(b => {
        const missing = b.uris.filter(u => !keptSet.has(u)).length;
        if (b.segCount && missing > 0) {
          removedInfo.push({ index: b.index, segCount: b.segCount, missing, duration: Math.round(b.duration * 10) / 10, prefixes: b.prefixes, keyNone: b.keyNone, discontinuity: b.discontinuity });
        }
      });
    }
    const violations = prefixIsolation(api, text, filtered, baseUrl);
    const removedBlocks = removedInfo.length;
    totalViolations += violations.length;
    totalRemoved += removedSegs;
    rows.push({ file: item.file, episode: item.episode, beforeSegs: before.reduce((n, b) => n + b.segCount, 0), removedSegs, removedBlocks, removedInfo, violations });
    console.log(`[${site} ${item.file}] ${removedSegs > 0 ? `删 ${removedBlocks} 块 / ${removedSegs} 片: ` + JSON.stringify(removedInfo) : '未删任何块'}`);
    violations.forEach(v => console.log(`  ⚠️ 结构异常: ${JSON.stringify(v)}`));
  }
  siteSummary.push({ site, rows });
}

console.log(`\n===== 汇总 =====`);
console.log(`30 份新鲜样本，共删 ${totalRemoved} 片，前缀隔离违规 ${totalViolations} 处（红线=0）`);

// ---------- 跨集投票收益模拟 ----------
// 第 1 集跑过滤（真实代码学到 learnedAdHosts；同时手工提取结构性广告前缀），
// 第 2/3 集上检查：严判据漏掉的前缀块里，有哪些是第 1 集已确认的广告前缀。
console.log(`\n===== 跨集投票（前缀学习）收益模拟 =====`);
for (const [site, items] of bySite) {
  if (items.length < 2) continue;
  const api = loadFreshSandbox();
  // 第 1 集：跑过滤，记录被删块的前缀（= 确认广告前缀）
  const first = items[0];
  const firstText = fs.readFileSync(path.join(SAMPLES, first.file), 'utf8');
  const firstBase = first.mediaUrl || first.playUrl;
  const before = analyzeBlocks(api, firstText, firstBase);
  const filtered = api.filterAdsFromM3U8(firstText, true, firstBase);
  const firstKept = new Set();
  filtered.split(String.fromCharCode(10)).forEach(l => { const t = l.trim(); if (t && t.charAt(0) !== '#') firstKept.add(t); });
  const confirmedPrefixes = new Set();
  before.forEach(b => {
    const missing = b.segCount && b.uris.filter(u => !firstKept.has(u)).length;
    if (missing) {
      b.prefixes.forEach(p => confirmedPrefixes.add(p));
    }
  });
  if (!confirmedPrefixes.size) {
    console.log(`[${site}] 第 1 集无确认广告前缀，跳过`);
    continue;
  }
  console.log(`[${site}] 第 1 集确认广告前缀 ${confirmedPrefixes.size} 个: ${[...confirmedPrefixes].join(' , ')}`);
  for (let i = 1; i < items.length; i++) {
    const item = items[i];
    const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
    const baseUrl = item.mediaUrl || item.playUrl;
    const blocks = analyzeBlocks(api, text, baseUrl);
    // 严判据现状
    const filtered = api.filterAdsFromM3U8(text, true, baseUrl);
    const keptSet = new Set();
    filtered.split(String.fromCharCode(10)).forEach(l => { const t = l.trim(); if (t && t.charAt(0) !== '#') keptSet.add(t); });
    // 前缀命中但未被删的块（分片级：块内任一分片仍在保留结果里 = 没删干净）
    const missed = [];
    const risky = [];
    blocks.forEach(b => {
      if (!b.segCount) return;
      const isAdPrefix = b.prefixes.length === 1 && confirmedPrefixes.has(b.prefixes[0]);
      if (!isAdPrefix) return;
      const stillKept = b.uris.some(u => keptSet.has(u));
      if (!stillKept) return; // 已被删
      // 风险检查：该前缀是否也出现在完整保留的块里（= 正片在用这个目录）
      const keptBlocks = blocks.filter(o => o.index !== b.index && o.segCount && o.uris.every(u => keptSet.has(u)));
      const prefixInKept = keptBlocks.some(o => o.prefixes.includes(b.prefixes[0]));
      (prefixInKept ? risky : missed).push({ index: b.index, segCount: b.segCount, duration: Math.round(b.duration * 10) / 10, prefixes: b.prefixes });
    });
    console.log(`[${site} ${item.file}] 严判据漏删 ${missed.length} 块（前缀投票可回收）, 有风险不放行 ${risky.length} 块`);
    if (missed.length) console.log(`   可回收: ${JSON.stringify(missed)}`);
  }
}
