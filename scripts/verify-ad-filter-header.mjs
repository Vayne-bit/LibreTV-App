// 回归：广告块被删时，清单头部标签必须保留。
//
// 背景（真实故障）：片头贴片广告没有断点标记，于是 #EXTM3U / #EXT-X-VERSION /
// #EXT-X-TARGETDURATION / #EXT-X-MEDIA-SEQUENCE 与广告分片同处第一块。
// 整块删除会把这些标签一起删掉，产出非法清单 —— 播放器/电视整份拒绝，
// 表现为黑屏转圈。本脚本锁住这个行为。
import fs from 'node:fs';
import vm from 'node:vm';

const handlerSrc = fs.readFileSync('public/js/player_artplayer_handler.js', 'utf8');

function ex(src, name) {
  const s = src.indexOf('function ' + name + '(');
  if (s < 0) throw new Error('缺少 ' + name);
  let d = 0, i = src.indexOf('{', s);
  for (; i < src.length; i++) { const c = src[i]; if (c === '{') d++; else if (c === '}') { d--; if (!d) { i++; break; } } }
  return src.slice(s, i);
}

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, detail ? `\n      ${detail}` : ''); }
}

function makeCtx(dropIndexes) {
  const sb = {
    window: {}, console, URL, Date, Set, Map, Math, JSON, parseFloat, parseInt,
    localStorage: { _d: {}, getItem(k) { return this._d[k] ?? null; }, setItem(k, v) { this._d[k] = String(v); } },
    navigator: { userAgent: 'test' }
  };
  sb.globalThis = sb;
  const ctx = vm.createContext(sb);
  const PRELUDE = `
const AD_BLOCK_MAX_SECONDS=300;const AD_REMOVE_MAX_RATIO=0.3;
const AD_HOST_PATTERNS=[];const AD_PATH_PATTERN=/xx/;
const LEARNED_AD_HOSTS_KEY='l';const PLAYLIST_MARKER_STATS_KEY='p';
const rawPlaylistCache=new Map();const RAW_PLAYLIST_CACHE_MAX=4;
let lastRawPlaylist=null;let lastRemovedSegmentIds=new Set();let lastRemovedSegmentUris=[];
`;
  const names = ['isDiscontinuityLine','splitPlaylistBlocks','playlistHost','isAdSegmentUri',
    'getLearnedAdHosts','rememberAdHosts','recordAdFilterStats','filterByHostRules','isAdStartTag','isAdEndTag',
    'filterByStructure','parseRawPlaylist','playlistPathPrefix','segmentIdentity',
    'computeRemovedSegmentIds','finishFiltering','getRawPlaylist','rememberRawPlaylist','playlistCacheKey'];
  vm.runInContext(PRELUDE + names.map(n => ex(handlerSrc, n)).join('\n'), ctx);
  // 用固定的删块结果替换判据，专测「删块时的输出结构」
  vm.runInContext(`function findAdBlockIndexes(){ return ${JSON.stringify(dropIndexes)}; }`, ctx);
  vm.runInContext('globalThis.__f = filterByStructure;', ctx);
  return sb;
}

const countSeg = t => t.split('\n').filter(l => { const s = l.trim(); return s && s[0] !== '#'; }).length;

console.log('\n[1] 片头贴片广告块（无断点）被整块删除');
{
  // 广告占比必须低于 AD_REMOVE_MAX_RATIO(30%)，否则会命中「删太多」兜底而不过滤
  const playlist = [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10',
    '#EXT-X-PLAYLIST-TYPE:VOD', '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXTINF:5,', 'ad/1.ts',
    '#EXTINF:5,', 'ad/2.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:10,', 'c1.ts',
    '#EXTINF:10,', 'c2.ts',
    '#EXTINF:10,', 'c3.ts',
    '#EXTINF:10,', 'c4.ts',
    '#EXT-X-ENDLIST'
  ].join('\n');
  const sb = makeCtx([0]);
  const out = sb.__f(playlist, playlist.split('\n'), 'https://src.example.com/vod/index.m3u8', true);
  console.log('    输出:', JSON.stringify(out));
  check('以 #EXTM3U 开头', out.trimStart().startsWith('#EXTM3U'), out);
  check('保留 #EXT-X-VERSION', out.includes('#EXT-X-VERSION:3'), out);
  check('保留 #EXT-X-TARGETDURATION', out.includes('#EXT-X-TARGETDURATION:10'), out);
  check('保留 #EXT-X-MEDIA-SEQUENCE', out.includes('#EXT-X-MEDIA-SEQUENCE:0'), out);
  check('广告分片已删净', !out.includes('ad/1.ts') && !out.includes('ad/2.ts'), out);
  check('正片四片都在', countSeg(out) === 4, `分片数=${countSeg(out)}`);
  check('无孤立 EXTINF（EXTINF 数 = 分片数）',
    (out.match(/#EXTINF/g) || []).length === countSeg(out),
    `EXTINF=${(out.match(/#EXTINF/g) || []).length}, 分片=${countSeg(out)}\n      ${out}`);
  check('保留 ENDLIST', out.includes('#EXT-X-ENDLIST'), out);
}

console.log('\n[2] 中间广告块被删，头部与断点不受影响');
{
  const playlist = [
    '#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:6',
    '#EXTINF:20,', 'c0.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:3,', 'ad/1.ts',
    '#EXTINF:3,', 'ad/2.ts',
    '#EXT-X-DISCONTINUITY',
    '#EXTINF:20,', 'c1.ts',
    '#EXT-X-ENDLIST'
  ].join('\n');
  const sb = makeCtx([1]);
  const out = sb.__f(playlist, playlist.split('\n'), 'https://src.example.com/vod/index.m3u8', true);
  console.log('    输出:', JSON.stringify(out));
  check('以 #EXTM3U 开头', out.trimStart().startsWith('#EXTM3U'), out);
  check('保留 TARGETDURATION', out.includes('#EXT-X-TARGETDURATION:6'), out);
  check('正片两片都在', countSeg(out) === 2, `分片数=${countSeg(out)}`);
  check('断点仍为一个', (out.match(/#EXT-X-DISCONTINUITY/g) || []).length === 1, out);
  check('广告已删净', !out.includes('ad/1.ts') && !out.includes('ad/2.ts'), out);
}

console.log('\n[3] 未判定出广告时清单原样返回');
{
  const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:1,\nc0.ts\n#EXT-X-ENDLIST';
  const sb = makeCtx([]);
  const out = sb.__f(playlist, playlist.split('\n'), 'https://src.example.com/vod/index.m3u8', true);
  check('内容不变', out === playlist, out);
}

console.log(`\n结果: ${pass} 通过, ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
