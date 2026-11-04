// 广告过滤误判率实测（已废弃 —— 见下）
//
// 本脚本的「真值函数」looksLikeAd 是旧宽判据时代的启发式：
//   · 片头片尾复用同一组分片的广告会被它判成「与正片共享分片 → 非广告」；
//   · 「时长不超过最长块一半」会把固定切片源的正片短块误标成广告。
// 用它当真值会产出失真结论（2026-11-05 曾据此误判「误伤 531」）。
// 判定必须唯一归属真实代码 + 独立真值，请改用：
//   · scripts/compare-old-new.mjs      —— 独立真值 + 新旧判据对比（样本目录参数同本脚本）
//   · scripts/measure-fresh-ad-filter.mjs —— 应用内 20 源站新鲜样本实测
//   · scripts/stress-ad-filter.mjs     —— 边界场景压力测试
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

console.log('本脚本已废弃：真值启发式过时（片头片尾复用分片的广告会被误判为非广告）。\n请改用 compare-old-new.mjs（独立真值+新旧对比）/ measure-fresh-ad-filter.mjs（新鲜样本）/ stress-ad-filter.mjs（边界场景）。');
process.exit(0);

const SAMPLES = process.argv[2] || '/tmp/plsamples';
const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLES, 'manifest.json'), 'utf8'));

// ---------- 从真实源码里抽取被测函数 ----------
const handlerSrc = fs.readFileSync(
  path.join(process.cwd(), 'public/js/player_artplayer_handler.js'), 'utf8');

function extractFunction(name) {
  const start = handlerSrc.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('未找到函数 ' + name);
  let depth = 0, i = handlerSrc.indexOf('{', start);
  const from = i;
  for (; i < handlerSrc.length; i++) {
    const ch = handlerSrc[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return handlerSrc.slice(start, i);
}

// 构造一个最小沙箱：把过滤相关函数都放进去
const sandbox = {
  window: {},
  localStorage: {
    _d: {},
    getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
    setItem(k, v) { this._d[k] = String(v); },
  },
  console,
  URL,
  Date,
  Set,
  Map,
  Math,
  JSON,
  parseFloat,
};
sandbox.globalThis = sandbox;
const ctx = vm.createContext(sandbox);

const NEEDED = [
  'isDiscontinuityLine', 'splitPlaylistBlocks', 'playlistHost', 'playlistPathPrefix', 'isAdSegmentUri',
  'getLearnedAdHosts', 'rememberAdHosts', 'recordAdFilterStats', 'filterByHostRules',
  'isAdStartTag', 'isAdEndTag', 'filterByStructure', 'filterAdsFromM3U8',
  'parseRawPlaylist', 'playlistPathPrefix', 'segmentIdentity', 'computeRemovedSegmentIds',
  'finishFiltering', 'getRawPlaylist', 'rememberRawPlaylist', 'playlistCacheKey',
  'findAdBlockIndexes',
];
const src = NEEDED.map(extractFunction).join('\n\n');
const PRELUDE = `
const AD_BLOCK_MAX_SECONDS = 300;
const AD_REMOVE_MAX_RATIO = 0.3;
const AD_HOST_PATTERNS = [
  'doubleclick.net', 'googlesyndication', 'googleadservices', 'admob',
  'adnxs.com', 'pubmatic.com', 'rubiconproject.com', 'criteo.com',
  'adcolony', 'vungle.com', 'applovin', 'mopub.com', 'unityads', 'inmobi.com',
  'taboola.com', 'outbrain.com', 'moatads.com', 'amazon-adsystem',
  'tanx.com', 'mediav.com', 'miaozhen.com', 'ipinyou.com', 'adsame',
  'admaster', 'adview.cn', 'allyes.com', 'adchina.com'
];
const AD_PATH_PATTERN = /(^|\\/)(ads?|adverts?|advertising|adcreative|adplayer|adframe|bannerads?|popunder|interstitial|preroll|midroll|postroll)(\\/|$)/i;
const LEARNED_AD_HOSTS_KEY = 'learnedAdHosts';
const PLAYLIST_MARKER_STATS_KEY = 'playlistMarkerStats';
`;
// 注入真实 locator（filterByStructure → findAdBlockIndexes 依赖 AdBlockLocator）
const locatorSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_ad_locator.js'), 'utf8')
  .replace('})(window);', '})(globalThis);');
const locCtx = vm.createContext({ window: {}, console, URL, Date, Set, Map, Math, JSON });
vm.runInContext(locatorSrc, locCtx);
sandbox.AdBlockLocator = locCtx.AdBlockLocator;
vm.runInContext(PRELUDE + src + '\nglobalThis.__api = { filterAdsFromM3U8, filterByStructure, filterByHostRules, splitPlaylistBlocks, playlistHost, isAdSegmentUri, parseRawPlaylist, findAdBlockIndexes };', ctx);
const api = sandbox.__api;

// ---------- 人工判据：这个块是不是广告 ----------
// 依据：广告块的典型特征 —— 有独立路径前缀、KEY NONE、固定时长、且与正片分片不共享任何分片
function analyzeBlocks(text, baseUrl) {
  const blocks = api.splitPlaylistBlocks(text.split('\n'), baseUrl);
  const info = blocks.map((b, i) => {
    const hosts = [...new Set(b.segments.map(s => api.playlistHost(s.uri, baseUrl)))];
    const prefixes = [...new Set(b.segments.map(s => {
      try { const u = new URL(s.uri, baseUrl); return u.host + u.pathname.replace(/[^/]*$/, ''); } catch (e) { return ''; }
    }))];
    const keyNone = b.lines.some(l => l.trim().indexOf('#EXT-X-KEY:METHOD=NONE') === 0);
    const durs = b.segments.map(s => s.duration);
    const uniq = [...new Set(durs.map(d => Math.round(d * 10) / 10))];
    return {
      index: i, discontinuity: b.discontinuity, keyNone,
      segCount: b.segments.length, duration: b.duration,
      hosts, prefixes, uniform: uniq.length <= 2,
      uris: b.segments.map(s => s.uri),
    };
  });
  return info;
}

// 判断一个块「像广告」：独立前缀 + 不与任何其他块共享分片 + 时长规整
function looksLikeAd(block, allBlocks) {
  if (!block.segCount) return { ad: false, reason: '空块' };
  if (!block.discontinuity) return { ad: false, reason: '无前置断点' };
  const sharedWithOther = allBlocks.some(o =>
    o.index !== block.index && o.uris.some(u => block.uris.includes(u)));
  if (sharedWithOther) return { ad: false, reason: '与正片共享分片' };
  const prefixCount = new Set(block.prefixes).size;
  const dominant = allBlocks
    .filter(o => o.index !== block.index)
    .reduce((m, o) => Math.max(m, o.duration), 0);
  if (block.duration > dominant * 0.5) return { ad: false, reason: `时长与正片同量级(${block.duration}s vs ${dominant}s)` };
  if (prefixCount > 1) return { ad: false, reason: `多前缀(${prefixCount})` };
  return { ad: true, reason: `独立前缀+无共享分片+时长${block.duration}s` };
}

// ---------- 逐样本分析 ----------
const report = [];
for (const item of manifest) {
  const file = path.join(SAMPLES, item.file);
  const text = fs.readFileSync(file, 'utf8');
  const baseUrl = item.url;

  // 参考：更严格的「真广告」判据用于评估
  const blocks = analyzeBlocks(text, baseUrl);
  const truth = blocks.map(b => looksLikeAd(b, blocks));

  // 当前结构法会删哪些块：直接跑真实 filterByStructure 的判定
  // （早期这里复刻的是旧宽判据 disjoint||resetKey，与 92d9e67 之后的
  //   严判据代码完全脱节，产出过「误伤 531」的失真结论 —— 判定必须
  //   唯一归属真实代码，harness 不自写第二份判据）
  const dropped = api.findAdBlockIndexes(
    api.splitPlaylistBlocks(text.split('\n'), baseUrl)
  );

  const totalSegments = blocks.reduce((n, b) => n + b.segCount, 0);
  const totalDuration = blocks.reduce((n, b) => n + b.duration, 0);
  const removedSegments = dropped.reduce((n, i) => n + blocks[i].segCount, 0);
  const removedDuration = dropped.reduce((n, i) => n + blocks[i].duration, 0);

  // 误伤 = 被删块在人工判据下「不像广告」
  const falsePositives = dropped.filter(i => !truth[i].ad);
  const truePositives = dropped.filter(i => truth[i].ad);
  // 漏删 = 人工判据认为是广告但没被删
  const falseNegatives = blocks.map((b, i) => i).filter(i => truth[i].ad && dropped.indexOf(i) < 0);

  report.push({
    site: item.site, keyword: item.keyword, url: item.url,
    blockCount: blocks.length, totalSegments, totalDuration: Math.round(totalDuration),
    discontinuityBlocks: blocks.filter(b => b.discontinuity).length,
    keyNoneBlocks: blocks.filter(b => b.keyNone).length,
    droppedBlocks: dropped.length,
    droppedDetail: dropped.map(i => ({
      index: i, segCount: blocks[i].segCount, duration: blocks[i].duration,
      hosts: blocks[i].hosts, prefixes: blocks[i].prefixes,
      uniform: blocks[i].uniform,
      verdict: truth[i].ad ? '广告' : '误伤', reason: truth[i].reason,
    })),
    removedRatio: totalDuration > 0 ? +(removedDuration / totalDuration).toFixed(4) : 0,
    truePositives: truePositives.length,
    falsePositives: falsePositives.length,
    falseNegatives: falseNegatives.length,
    truthAdBlocks: truth.filter(t => t.ad).length,
    abortedByRatioGuard: removedSegments >= totalSegments || removedDuration > totalDuration * 0.3,
  });
}

// ---------- 汇总 ----------
console.log('\n=== 逐样本结果 ===');
for (const r of report) {
  console.log(`\n[${r.site}] ${r.keyword}`);
  console.log(`  块数 ${r.blockCount}（含断点 ${r.discontinuityBlocks}，KEY:NONE ${r.keyNoneBlocks}） 分片 ${r.totalSegments} 总时长 ${r.totalDuration}s`);
  console.log(`  结构法删除 ${r.droppedBlocks} 块 → 真广告 ${r.truePositives} / 误伤 ${r.falsePositives} / 漏删 ${r.falseNegatives}（人工判定广告块共 ${r.truthAdBlocks}）`);
  console.log(`  删除时长占比 ${(r.removedRatio * 100).toFixed(2)}%  30%兜底触发=${r.abortedByRatioGuard}`);
  r.droppedDetail.forEach(d => {
    console.log(`    - 块${d.index}: ${d.segCount}片/${d.duration}s host=${d.hosts.join(',')} 前缀=${d.prefixes.join(',')} 规整=${d.uniform} → ${d.verdict}(${d.reason})`);
  });
}

const tot = report.reduce((a, r) => ({
  tp: a.tp + r.truePositives, fp: a.fp + r.falsePositives, fn: a.fn + r.falseNegatives,
  blocks: a.blocks + r.droppedBlocks,
}), { tp: 0, fp: 0, fn: 0, blocks: 0 });
console.log('\n=== 汇总 ===');
console.log(`样本 ${report.length} 个，结构法删除块 ${tot.blocks} 个`);
console.log(`真广告 ${tot.tp} / 误伤 ${tot.fp} / 漏删 ${tot.fn}`);
console.log(`精确率 ${tot.tp + tot.fp > 0 ? (tot.tp / (tot.tp + tot.fp) * 100).toFixed(1) : 'N/A'}%  召回率 ${tot.tp + tot.fn > 0 ? (tot.tp / (tot.tp + tot.fn) * 100).toFixed(1) : 'N/A'}%`);
const fpSamples = report.filter(r => r.falsePositives > 0).map(r => r.site);
if (fpSamples.length) console.log(`存在误伤的样本站：${[...new Set(fpSamples)].join(', ')}`);

fs.writeFileSync(path.join(SAMPLES, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
