// 对比三套候选判据，选出既零误伤又覆盖最广的一套
//   A 宽判据（现状）：断点 + 短块 + (异域名 | KEY_NONE)
//   B locator 严判据：断点 + KEY_NONE + 单前缀 + 时长规整 + 安全阀
//   C 改进判据：断点 + 短块 + (KEY_NONE | 少数派前缀)，「异域名」改成「全片占比少数派」
//      —— 修掉宽判据的连锁误判根因：contentHosts 只在非广告块累积，
//         第一个块之后所有块都因「host 没出现过」而被判不相交
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
vm.runInContext(`const AD_BLOCK_MAX_SECONDS=300;const AD_REMOVE_MAX_RATIO=0.3;const AD_HOST_PATTERNS=[];const AD_PATH_PATTERN=/xx/;const LEARNED_AD_HOSTS_KEY='l';const PLAYLIST_MARKER_STATS_KEY='p';const rawPlaylistCache=new Map();let lastRawPlaylist=null;let lastRemovedSegmentIds=new Set();` +
  ['isDiscontinuityLine','splitPlaylistBlocks','playlistHost','parseRawPlaylist','playlistPathPrefix']
    .map(n => ex(handlerSrc, n)).join('\n') + '\nglobalThis.__a={splitPlaylistBlocks,playlistHost};', ctx);
const A = sb.__a;
const locCtx = vm.createContext({ window: {}, console, URL, Date, Set, Map, Math, JSON });
vm.runInContext(locatorSrc.replace('})(window);', '})(globalThis);'), locCtx);
const Locator = locCtx.AdBlockLocator;

function prefixOf(uri, baseUrl) {
  try { const u = new URL(uri, baseUrl); return u.host + u.pathname.replace(/[^/]*$/, ''); } catch (e) { return ''; }
}
function analyze(text, baseUrl) {
  const blocks = A.splitPlaylistBlocks(text.split('\n'));
  const info = blocks.map((b, i) => {
    const segments = b.segments.map(s => ({ uri: s.uri, duration: s.duration, pathPrefix: prefixOf(s.uri, baseUrl) }));
    const keyNone = b.lines.some(l => l.trim().indexOf('#EXT-X-KEY:METHOD=NONE') === 0);
    const durs = segments.map(s => Math.round(s.duration * 10) / 10);
    const counts = new Map();
    durs.forEach(d => counts.set(d, (counts.get(d) || 0) + 1));
    let mode = 0, modeCount = 0;
    counts.forEach((n, d) => { if (n > modeCount) { modeCount = n; mode = d; } });
    let matching = 0, outliers = 0;
    segments.forEach(s => {
      const d = Math.round(s.duration * 10) / 10;
      if (Math.abs(d - mode) <= mode * 0.15) matching++;
      else if (s.duration < mode * 0.7) outliers++;
    });
    const uniform = mode > 0 && matching + outliers >= segments.length && matching >= Math.max(1, Math.ceil(segments.length / 2));
    return {
      index: i, discontinuity: b.discontinuity, keyNone, segments,
      duration: b.segments.reduce((n, s) => n + s.duration, 0),
      prefixes: [...new Set(segments.map(s => s.pathPrefix))], uniform,
    };
  });
  return info;
}
// 前缀在全片的时长占比
function prefixShare(info) {
  const total = info.reduce((n, b) => n + b.duration, 0);
  const dur = new Map();
  info.forEach(b => b.segments.forEach(s => dur.set(s.pathPrefix, (dur.get(s.pathPrefix) || 0) + s.duration)));
  return { total, dur };
}
// 真值
function groundTruth(text, baseUrl) {
  const info = analyze(text, baseUrl);
  const { total, dur } = prefixShare(info);
  return info.map(b => {
    let isAd = false;
    if (b.discontinuity && b.keyNone && b.prefixes.length === 1 && b.duration > 0 && b.duration <= 300) {
      isAd = total > 0 && (dur.get(b.prefixes[0]) || 0) / total <= 0.3;
    }
    return { ...b, isAd };
  });
}
// A 宽判据
function judgeA(info) {
  const contentHosts = new Set(); const dropped = [];
  info.forEach(b => {
    if (!b.segments.length) return;
    const hosts = [...new Set(b.segments.map(s => { try { return new URL(s.uri, 'https://x.invalid/').host; } catch (e) { return ''; } }))];
    const resetKey = b.keyNone;
    const short = b.duration > 0 && b.duration <= 300;
    const disjoint = hosts.every(h => !contentHosts.has(h));
    if (b.discontinuity && short && (disjoint || resetKey)) { dropped.push(b.index); return; }
    hosts.forEach(h => contentHosts.add(h));
  });
  return dropped;
}
// B locator 严判据
function judgeB(info, baseUrl) {
  const playlist = { blocks: info.map(b => ({
    discontinuity: b.discontinuity, keyNone: b.keyNone,
    segments: b.segments.map(s => ({ uri: s.uri, duration: s.duration, pathPrefix: s.pathPrefix })),
    duration: b.duration })), segments: [], totalDuration: 0 };
  playlist.segments = playlist.blocks.flatMap(b => b.segments);
  playlist.totalDuration = playlist.blocks.reduce((n, b) => n + b.duration, 0);
  return Locator.findAdBlockCandidates(playlist).map(c => c.blockIndex);
}
// C 改进判据：异域名改成「少数派前缀」
function judgeC(info) {
  const { total, dur } = prefixShare(info);
  const dropped = [];
  info.forEach(b => {
    if (!b.segments.length) return;
    if (!b.discontinuity) return;
    if (!(b.duration > 0 && b.duration <= 300)) return;
    if (b.segments.length > 40) return;
    const shares = b.prefixes.map(p => (dur.get(p) || 0) / total);
    const minority = shares.some(s => s <= 0.3);
    const uniformOk = b.uniform;
    // 命中条件：KEY_NONE 且单前缀，或（少数派前缀 且 时长规整）
    const isAd = b.keyNone ? (b.prefixes.length === 1 && minority)
                           : (b.prefixes.length === 1 && minority && uniformOk);
    if (isAd) dropped.push(b.index);
  });
  return dropped;
}

function injectAd(text) {
  const lines = text.split('\n');
  const idx = lines.findIndex(l => l.trim() === '#EXT-X-DISCONTINUITY');
  if (idx < 0) return null;
  const ad = ['#EXT-X-DISCONTINUITY','#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:5,','https://ads.vendor.net/spot/hls/ad0.ts','#EXTINF:5,','https://ads.vendor.net/spot/hls/ad1.ts',
    '#EXTINF:5,','https://ads.vendor.net/spot/hls/ad2.ts','#EXTINF:5,','https://ads.vendor.net/spot/hls/ad3.ts'];
  return [...lines.slice(0, idx+1), ...ad, ...lines.slice(idx+1)].join('\n');
}

function run(label, judge, texts) {
  let tp = 0, fp = 0, fn = 0; const fpDetail = [];
  for (const item of texts) {
    const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
    const truth = groundTruth(text, item.url);
    const truthSet = new Set(truth.filter(t => t.isAd).map(t => t.index));
    const info = analyze(text, item.url);
    const dropped = judge(info, item.url);
    const fpN = dropped.filter(i => !truthSet.has(i)).length;
    tp += dropped.filter(i => truthSet.has(i)).length; fp += fpN;
    fn += truthSet.size - dropped.filter(i => truthSet.has(i)).length;
    if (fpN) fpDetail.push(`${item.site}/${item.keyword}`);
  }
  console.log(`  ${label}: 命中 ${tp} / 误伤 ${fp} / 漏删 ${fn}  精确率 ${tp+fp>0?(tp/(tp+fp)*100).toFixed(1):'—'}%  召回率 ${tp+fn>0?(tp/(tp+fn)*100).toFixed(1):'—'}%${fpDetail.length?'  误伤样本: '+[...new Set(fpDetail)].join(','):''}`);
}

const base = manifest.map(item => ({ ...item }));
const injected = [];
for (const item of manifest) {
  const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
  const inj = injectAd(text);
  if (!inj) continue;
  const file = path.join(SAMPLES, '__inj_' + item.file);
  fs.writeFileSync(file, inj, 'utf8');
  injected.push({ ...item, file: '__inj_' + item.file });
}

console.log('\n=== 三套判据对比 ===\n');
console.log('【场景A：40 个真实清单】');
run('A 宽判据(现状) ', judgeA, base);
run('B locator严判据', judgeB, base);
run('C 改进判据    ', judgeC, base);
console.log('\n【场景B：注入真广告后】');
run('A 宽判据(现状) ', judgeA, injected);
run('B locator严判据', judgeB, injected);
run('C 改进判据    ', judgeC, injected);
injected.forEach(i => { try { fs.unlinkSync(path.join(SAMPLES, i.file)); } catch (e) {} });

// 额外：把 bfzy 的 adjump 块单独看看 C 能不能命中
console.log('\n【bfzy adjump（防跳片段，非传统广告）】');
for (const item of manifest.filter(x => x.site === 'bfzy')) {
  const text = fs.readFileSync(path.join(SAMPLES, item.file), 'utf8');
  if (!/adjump/.test(text)) continue;
  const info = analyze(text, item.url);
  const c = judgeC(info, item.url);
  const adjumpBlocks = info.filter(b => b.segments.some(s => /adjump/.test(s.uri))).map(b => b.index);
  console.log(`  ${item.keyword}: adjump 块=${JSON.stringify(adjumpBlocks)} C 判据删块=${JSON.stringify(c)}`);
}
