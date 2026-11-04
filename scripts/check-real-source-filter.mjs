// 用真实站源清单跑完整过滤链路，回答三个问题：
//   1. 这条真实源的广告块会不会被识别（名单是否非空）
//   2. 有没有连正片一起删（误删）
//   3. 过滤后的清单头部标签是否完整（投屏代理会原样下发，缺头必然黑屏）
// 用法：node scripts/check-real-source-filter.mjs <m3u8 文件> <baseUrl>
import fs from 'node:fs';
import vm from 'node:vm';

const file = process.argv[2];
const baseUrl = process.argv[3] || 'https://v.fengbao14.com/video/x/46a1bb96bba0/index.m3u8';
const content = fs.readFileSync(file, 'utf8');
const handlerSrc = fs.readFileSync('public/js/player_artplayer_handler.js', 'utf8');
const locatorSrc = fs.readFileSync('public/js/player_ad_locator.js', 'utf8');

function ex(src, name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) throw new Error('缺少 ' + name);
  let d = 0, i = src.indexOf('{', s);
  for (; i < src.length; i++) { const c = src[i]; if (c === '{') d++; else if (c === '}') { d--; if (!d) { i++; break; } } }
  return src.slice(s, i);
}

const sb = {
  window: {}, console, URL, Date, Set, Map, Math, JSON, parseFloat, parseInt,
  localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
  navigator: { userAgent: 'test' }
};
sb.globalThis = sb;
const ctx = vm.createContext(sb);

const PRELUDE = `
const AD_BLOCK_MAX_SECONDS=300;const AD_REMOVE_MAX_RATIO=0.3;
const AD_HOST_PATTERNS=['doubleclick.net','googlesyndication','adnxs.com','pubmatic.com','rubiconproject.com','criteo.com','taboola.com','outbrain.com','moatads.com','tanx.com','mediav.com','miaozhen.com','ipinyou.com','adsame','admaster','adview.cn','allyes.com','adchina.com'];const AD_PATH_PATTERN=/(^|\\/)(ads?|adverts?|advertising|adcreative|adplayer|adframe|bannerads?|popunder|interstitial|preroll|midroll|postroll)(\\/|$)/i;
const LEARNED_AD_HOSTS_KEY='l';const PLAYLIST_MARKER_STATS_KEY='p';
const rawPlaylistCache=new Map();const RAW_PLAYLIST_CACHE_MAX=4;
let lastRawPlaylist=null;let lastRemovedSegmentIds=new Set();let lastRemovedSegmentUris=[];
`;

const names = ['isDiscontinuityLine','splitPlaylistBlocks','playlistHost','isAdSegmentUri',
  'getLearnedAdHosts','rememberAdHosts','recordAdFilterStats','filterByHostRules','isAdStartTag','isAdEndTag',
  'filterByStructure','filterAdsFromM3U8','parseRawPlaylist','playlistPathPrefix','segmentIdentity',
  'computeRemovedSegmentIds','finishFiltering','getRawPlaylist','rememberRawPlaylist','playlistCacheKey',
  'findAdBlockIndexes'];

vm.runInContext(PRELUDE + names.map(n => ex(handlerSrc, n)).join('\n'), ctx);

// 注入真实 locator（与页面加载一致：window.AdBlockLocator）
const locCtx = vm.createContext({ window: {}, console, URL, Date, Set, Map, Math, JSON });
vm.runInContext(locatorSrc.replace('})(window);', '})(globalThis);'), locCtx);
sb.AdBlockLocator = locCtx.AdBlockLocator;

sb.__content = content;
sb.__baseUrl = baseUrl;

vm.runInContext('globalThis.__remember = rememberRawPlaylist; globalThis.__filter = filterAdsFromM3U8; globalThis.__removed = () => lastRemovedSegmentUris;', ctx);

const before = sb.__remember(content, baseUrl);
const filtered = sb.__filter(content, true, baseUrl);
const removed = Array.from(sb.__removed());

const countSeg = (t) => t.split('\n').filter(l => { const s = l.trim(); return s && s[0] !== '#'; }).length;
const headLines = (t) => t.split('\n').slice(0, 6).join('\n');

console.log('=== 原始清单 ===');
console.log('分片数:', countSeg(content));
console.log('头部:', JSON.stringify(headLines(content)));

console.log('\n=== 过滤结果 ===');
console.log('分片数:', countSeg(filtered), '（删掉', countSeg(content) - countSeg(filtered), '片）');
console.log('名单条数:', removed.length);
console.log('名单内容:', JSON.stringify(removed, null, 1));

console.log('\n=== 关键检查 ===');
const startsOk = filtered.trimStart().startsWith('#EXTM3U');
const hasTarget = filtered.includes('#EXT-X-TARGETDURATION');
console.log('过滤后以 #EXTM3U 开头:', startsOk);
console.log('过滤后保留 #EXT-X-TARGETDURATION:', hasTarget);
console.log('过滤后头部:', JSON.stringify(headLines(filtered)));

// 被删分片的通用误删判据：其路径前缀也出现在保留分片里 = 正片在用同一目录
// （早期的 /adjump/ 硬编码只适用于 fengbao14 一家，对其他源全是误报）
const prefixOf = (u) => { try { const x = new URL(u, baseUrl); return x.host + x.pathname.replace(/[^/]*$/, ''); } catch (e) { return null; } };
const keptPrefixes = new Set();
filtered.split(String.fromCharCode(10)).forEach(l => { const t = l.trim(); if (t && t[0] !== '#') { const p = prefixOf(t); if (p) keptPrefixes.add(p); } });
const wrong = removed.filter(u => { const p = prefixOf(u); return p && keptPrefixes.has(p); });
console.log('\n被删分片中不属于广告目录的（即疑似误删正片）:', wrong.length, JSON.stringify(wrong.slice(0, 10)));
