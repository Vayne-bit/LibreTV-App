// 验证宿主特征法删块后的断点还原：
// 删过广告块后，输出清单必须保留保留块自己的 #EXT-X-DISCONTINUITY
// （splitter 把断点行吃进标记位、不存进 lines——以前整份输出一个断点都不剩，
//   remuxer 在时间戳跳变处按连续时间轴算分段时长 → 缓冲空洞/卡死）。
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
const AD_HOST_PATTERNS = ['ads.example.net']; // 命中广告域名，触发宿主特征法
const AD_PATH_PATTERN = /(never-matches)/i;
const LEARNED_AD_HOSTS_KEY = 'learnedAdHosts'; const PLAYLIST_MARKER_STATS_KEY = 'playlistMarkerStats';
let lastRawPlaylist = null; let lastRemovedSegmentIds = new Set(); let lastRemovedSegmentUris = [];
const rawPlaylistCache = new Map(); const RAW_PLAYLIST_CACHE_MAX = 4;
const removedSegmentsByPlaylist = new Map();
`;
vm.runInContext(PRELUDE + locatorSrc + '\n' + FNS.map(n => ex(handlerSrc, n)).join('\n\n') +
  '\nglobalThis.__api = { filterAdsFromM3U8 };', ctx);
const api = sb.__api;

// 结构：正片(带断点) → 广告(ads.example.net) → 正片(带断点) → 广告 → 正片
const lines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10'];
const addMain = (prefix, n) => {
  lines.push('#EXT-X-DISCONTINUITY');
  for (let i = 1; i <= n; i++) { lines.push('#EXTINF:6,'); lines.push(`${prefix}m${i}.ts`); }
};
const addAd = () => {
  lines.push('#EXT-X-DISCONTINUITY');
  lines.push('#EXTINF:5,', 'https://ads.example.net/spot/1.ts');
  lines.push('#EXTINF:5,', 'https://ads.example.net/spot/2.ts');
};
addMain('https://main.cdn/p1/', 10);
addAd();
addMain('https://main.cdn/p2/', 10);
addAd();
addMain('https://main.cdn/p3/', 10);
lines.push('#EXT-X-ENDLIST');
const original = lines.join('\n');
const originalMarkers = (original.match(/#EXT-X-DISCONTINUITY/g) || []).length;

const filtered = api.filterAdsFromM3U8(original, true, 'https://main.cdn/x/index.m3u8');
const filteredMarkers = (filtered.match(/#EXT-X-DISCONTINUITY/g) || []).length;
const keptSegments = filtered.split('\n').filter(l => l.trim() && l.trim()[0] !== '#');
const removedAds = !filtered.includes('ads.example.net');

let failed = 0;
const check = (name, cond) => { console.log((cond ? '✅' : '❌') + ' ' + name); if (!cond) failed++; };
check('广告域名分片被整块删除', removedAds);
check(`每个保留内容块都有断点（原 ${originalMarkers} 个里 2 个随广告块消失，输出 ${filteredMarkers} 个）`,
  filteredMarkers === 3);
check('断点数量 = 保留块数（3 个正片块）', filteredMarkers === 3);
check('正片分片一个不少', keptSegments.filter(u => u.includes('main.cdn')).length === 30);
check('输出以 #EXTM3U 开头', filtered.trimStart().startsWith('#EXTM3U'));

process.exit(failed ? 1 : 0);
