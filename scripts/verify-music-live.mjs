// 音乐模块真实链路端到端验证（真实网络）：
//   实际内置酷狗源代码：搜索 → 播放直链探测（206/audio）→ 歌词下载+解析
//   + 聚合装配：内置源 + 模拟第二源并发搜索合并
// 运行：node scripts/verify-music-live.mjs
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();
let failed = 0;
const check = (name, cond) => { console.log((cond ? '✅' : '❌') + ' ' + name); if (!cond) failed++; };

function makeSandbox() {
  const storage = { _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k]; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  const sb = {
    window: {}, console, URL, Date, Set, Map, Math, JSON, parseFloat, fetch, AbortController, setTimeout, clearTimeout,
    encodeURIComponent, decodeURIComponent, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    escape: (s) => String(s).replace(/[^\x00-\x7e]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')),
    localStorage: storage, navigator: {},
  };
  // __win 必须就是全局自身：浏览器里 window===globalThis，
  // 插件挂到 window 上的东西其它模块要能用裸名访问到
  sb.globalThis = sb;
  sb.__win = sb;
  vm.createContext(sb);
  return sb;
}

function runIn(sb, relPath) {
  let code = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  code = code.replace(/\}\)\(window\);?\s*$/, '})(globalThis.__win);');
  vm.runInContext(code, sb);
}

// ---------- 装配真实模块 ----------
const sb = makeSandbox();
sb.isTauriApp = () => false; // 强制走浏览器 fetch（本机 Node 可直连）
runIn(sb, 'public/js/music/music_plugins.js');
runIn(sb, 'public/js/music/music_lyrics.js');
runIn(sb, 'public/js/music/music_core.js');
runIn(sb, 'public/js/music/music_search.js');
const MusicPlugin = sb.MusicPlugin;
// vm 顶层 const 是词法绑定不挂全局：读状态必须走 runInContext
const g = (expr) => vm.runInContext(expr, sb);
MusicPlugin.loadStoredMusicPlugins();

// ---------- 1. 真实搜索 ----------
console.log('== 1. 真实搜索「晴天」 ==');
const searchResult = await new Promise((resolve) => {
  sb.musicSearchUI = {
    onStart() {}, onPartial() {}, onDone() { resolve(null); },
  };
  sb.musicSearchStart('晴天');
  setTimeout(() => resolve(null), 20000);
});
const results = g('musicSearchState.results');
check('聚合搜索有结果（≥5）', results.length >= 5);
check('全部标注平台', results.every(item => item.platform));
check('字段齐全（title/artist）', results.every(item => item.title && item.artist));
console.log('   前 3 条:', results.slice(0, 3).map(item => `${item.title} - ${item.artist} [${item.platform}]`).join(' / '));

// ---------- 2. 播放直链（真实音频探测） ----------
console.log('== 2. 播放直链 ==');
const target = results.find(item => item.hash) || results[0];
const media = await MusicPlugin.resolveMusicSource(target, 'standard');
check('解析到播放 URL', !!(media && media.url));
if (media && media.url) {
  const audio = await fetch(media.url, { headers: { Range: 'bytes=0-2047' } });
  const buf = Buffer.from(await audio.arrayBuffer());
  const head = buf.subarray(0, 3).toString('hex');
  check('音频可取（206/200 + audio 类型 + MP3 头）',
    (audio.status === 206 || audio.status === 200)
    && String(audio.headers.get('content-type') || '').includes('audio')
    && (head === '494433' || head.startsWith('fff')));
  console.log('   URL:', media.url.slice(0, 80) + '...', '| CT:', audio.headers.get('content-type'), '| 总大小:', (audio.headers.get('content-range') || '').split('/')[1]);
}

// ---------- 3. 歌词 ----------
console.log('== 3. 歌词 ==');
const lyric = await MusicPlugin.fetchMusicLyric(target);
check('取到歌词文本', !!(lyric && lyric.rawLrc && lyric.rawLrc.includes('[')));
const lines = sb.parseLrcText(lyric ? lyric.rawLrc : '');
check('LRC 解析出带时间行（≥5）', lines.length >= 5);
if (lines.length) console.log('   首行:', JSON.stringify(lines[0]));

// ---------- 4. 多源聚合装配（内置源 + 模拟第二源） ----------
console.log('== 4. 多源聚合 ==');
MusicPlugin.importMusicPlugin(`
  module.exports = {
    platform: '模拟源B', version: '1.0.0',
    search: async (q) => ({ isEnd: true, data: [
      { id: 'b1', title: '晴天(模拟B)', artist: '测试歌手' },
      { id: 'b2', title: '另一首', artist: '测试歌手' }
    ] }),
    getMediaSource: async () => ({ url: 'https://example.org/b.mp3' })
  };`);
const countBefore = g('musicSearchState.results').length;
await new Promise((resolve) => {
  sb.musicSearchUI = { onStart() {}, onPartial() {}, onDone() { resolve(null); } };
  sb.musicSearchStart('晴天');
  setTimeout(() => resolve(null), 25000);
});
const merged = g('musicSearchState.results');
check('第二源结果并入聚合', merged.some(item => item.platform === '模拟源B'));
check('原有源结果仍在', merged.length >= countBefore);
const dedupOk = g('(new Set(musicSearchState.results.map(musicKey))).size === musicSearchState.results.length');
check('聚合去重键无冲突', dedupOk);

// ---------- 5. 播放装配（mock <audio>，验证 playAt 全流程） ----------
// 校验基准 = 「用户点的曲目」（第一轮快照首条），不是第二轮聚合的新首条
//（第二轮聚合里模拟源并发先完成，会排到前面——这是正常的完成序，不是 bug）
const musicKeyOfFirst = (results[0].platform || '') + '|' + (results[0].id || '');
console.log('== 5. 播放装配（模拟 Audio） ==');
const playCalls = [];
class FakeAudio {
  constructor() { this.src = ''; this.paused = true; this.listeners = {}; }
  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  play() { playCalls.push(this.src); this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
}
// document stub（歌词渲染需要）
sb.document = {
  getElementById: () => null,
  querySelectorAll: () => [],
  createElement: () => ({ style: {}, classList: { add() {}, toggle() {} }, addEventListener() {}, remove() {} }),
  body: { appendChild() {}, classList: { toggle() {} } },
};
sb.Audio = FakeAudio; // 注入模拟 <audio>
runIn(sb, 'public/js/music/music_player.js');
sb.musicSearchPlayAll(results[0]);
// 播放要等真实网络解析（getSongInfo ~1-2s），给足时间
await new Promise(r => setTimeout(r, 8000));
check('播放调用发生且 src 为真实音频地址', playCalls.length > 0 && playCalls[0].includes('http'));
check('队列 = 聚合结果', g('musicState.queue.length') === merged.length);
check('当前下标指向所点曲目', g('musicKey(musicState.queue[musicState.index])') === musicKeyOfFirst);

console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
