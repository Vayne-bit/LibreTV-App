// 验证「被删分片名单按清单地址分键」：
// 同一页面并发跑两条过滤（播放中的清单 A + 后台下载的清单 B），
// A 的名单不能被 B 覆盖 —— 人工标记换算与投屏名单都按各自的清单取。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const handlerSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_artplayer_handler.js'), 'utf8');
const locatorSrc = fs.readFileSync(path.join(process.cwd(), 'public/js/player_ad_locator.js'), 'utf8')
  .replace('})(window);', '})(globalThis);');

function ex(src, name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) throw new Error('缺 ' + name);
  let d = 0, i = src.indexOf('{', s);
  for (; i < src.length; i++) { const c = src[i]; if (c === '{') d++; else if (c === '}') { d--; if (!d) { i++; break; } } }
  return src.slice(s, i);
}

const FNS = [
  'isDiscontinuityLine', 'splitPlaylistBlocks', 'playlistHost', 'playlistPathPrefix',
  'isAdSegmentUri', 'getLearnedAdHosts', 'rememberAdHosts', 'recordAdFilterStats',
  'filterByHostRules', 'isAdStartTag', 'isAdEndTag', 'filterByStructure',
  'findAdBlockIndexes', 'filterAdsFromM3U8', 'finishFiltering', 'computeRemovedSegmentIds',
  'parseRawPlaylist', 'segmentIdentity', 'playlistCacheKey', 'getRawPlaylist',
  'rememberRawPlaylist', 'rememberRemovedSegments', 'getRemovedSegmentIds', 'getRemovedSegmentUris',
];

const sb = {
  window: {},
  localStorage: { _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k]; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } },
  console, URL, Date, Set, Map, Math, JSON, parseFloat,
};
sb.globalThis = sb;
const ctx = vm.createContext(sb);
const PRELUDE = `
const AD_BLOCK_MAX_SECONDS = 300; const AD_REMOVE_MAX_RATIO = 0.3;
const AD_HOST_PATTERNS = []; const AD_PATH_PATTERN = /(xx)/i;
const LEARNED_AD_HOSTS_KEY = 'learnedAdHosts'; const PLAYLIST_MARKER_STATS_KEY = 'playlistMarkerStats';
let lastRawPlaylist = null; let lastRemovedSegmentIds = new Set(); let lastRemovedSegmentUris = [];
const removedSegmentsByPlaylist = new Map();
const rawPlaylistCache = new Map(); const RAW_PLAYLIST_CACHE_MAX = 4;
`;
vm.runInContext(PRELUDE + locatorSrc + '\n' + FNS.map(n => ex(handlerSrc, n)).join('\n\n') +
  '\nglobalThis.__api = { filterAdsFromM3U8, rememberRawPlaylist, getRawPlaylist, getRemovedSegmentIds, getRemovedSegmentUris };', ctx);
const api = sb.__api;

// 清单 A（播放中）：带一个广告块（adA 前缀）；主片足够长让广告占比低于 30% 安全阀
const mainA = [];
for (let i = 1; i <= 20; i++) mainA.push('#EXTINF:6,', `https://main.cdn/a${i}.ts`);
const playlistA = [
  '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10',
  '#EXT-X-DISCONTINUITY', '#EXT-X-KEY:METHOD=NONE',
  '#EXTINF:5,', 'https://adA.cdn/spot/1.ts', '#EXTINF:5,', 'https://adA.cdn/spot/2.ts',
  '#EXT-X-DISCONTINUITY',
  ...mainA,
  '#EXT-X-ENDLIST',
].join('\n');
// 清单 B（后台下载的另一集）：广告块是 adB 前缀、3 个分片
const mainB = [];
for (let i = 1; i <= 20; i++) mainB.push('#EXTINF:6,', `https://main.cdn/b${i}.ts`);
const playlistB = [
  '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10',
  '#EXT-X-DISCONTINUITY', '#EXT-X-KEY:METHOD=NONE',
  '#EXTINF:5,', 'https://adB.cdn/spot/1.ts', '#EXTINF:5,', 'https://adB.cdn/spot/2.ts',
  '#EXTINF:5,', 'https://adB.cdn/spot/3.ts',
  '#EXT-X-DISCONTINUITY',
  ...mainB,
  '#EXT-X-ENDLIST',
].join('\n');

const urlA = 'https://cdn.example.com/ep5/index.m3u8';
const urlB = 'https://cdn.example.com/ep6/index.m3u8';

api.rememberRawPlaylist(playlistA, urlA);
api.rememberRawPlaylist(playlistB, urlB);

// 顺序：先过滤 A（播放侧），再过滤 B（下载侧）—— B 会覆盖「全局最近一次」
api.filterAdsFromM3U8(playlistA, true, urlA); api.filterAdsFromM3U8(playlistB, true, urlB);

console.log('urisA=',JSON.stringify(api.getRemovedSegmentUris(urlA)));console.log('urisB=',JSON.stringify(api.getRemovedSegmentUris(urlB)));console.log('global=',JSON.stringify(api.getRemovedSegmentUris()));const idsA = api.getRemovedSegmentIds(urlA);
const urisA = api.getRemovedSegmentUris(urlA);
const idsB = api.getRemovedSegmentIds(urlB);
const urisB = api.getRemovedSegmentUris(urlB);

let failed = 0;
const check = (name, cond) => { console.log((cond ? '✅' : '❌') + ' ' + name); if (!cond) failed++; };

check('A 的名单仍含 A 的广告分片（未被 B 覆盖）', urisA.some(u => u.includes('adA.cdn')));
check('A 的名单不含 B 的广告分片', !urisA.some(u => u.includes('adB.cdn')));
check('B 的名单含 B 的 3 个广告分片', urisB.filter(u => u.includes('adB.cdn')).length === 3);
check('A/B 名单互不相同（按地址分键生效）', urisA.join() !== urisB.join());
check('A 的 ids 是 Set（换算可直接用）', idsA instanceof Set && idsA.size === 2);
check('B 的 ids 有 3 个', idsB instanceof Set && idsB.size === 3);
// 不传参保持旧语义（返回全局最近一次 = B 的）
check('不传参保持旧行为（全局最近一次 = B）', api.getRemovedSegmentUris().some(u => u.includes('adB.cdn')));

process.exit(failed ? 1 : 0);
