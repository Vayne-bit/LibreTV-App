// 音乐模块沙箱验证：插件契约、LRC 解析、队列操作、酷狗字段映射、页面完整性。
// 不依赖网络（酷狗真实链路另见 verify-music-live.mjs）。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = process.cwd();
let failed = 0;
const check = (name, cond) => { console.log((cond ? '✅' : '❌') + ' ' + name); if (!cond) failed++; };

function makeSandbox() {
  const storage = { _d: {}, getItem(k) { return this._d[k] === undefined ? null : this._d[k]; }, setItem(k, v) { this._d[k] = String(v); }, removeItem(k) { delete this._d[k]; } };
  const sb = {
    window: {}, console, URL, Date, Set, Map, Math, JSON, parseFloat, Number, String, Array, Object, RegExp,
    encodeURIComponent, decodeURIComponent, atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    escape: (s) => String(s).replace(/[^\x00-\x7e]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')), localStorage: storage,
    fetch: async () => { throw new Error('沙箱无网络'); },
    navigator: {},
  };
  sb.globalThis = sb;
  return sb;
}

function loadModule(sb, relPath, exportsName) {
  const code = fs.readFileSync(path.join(ROOT, relPath), 'utf8')
    .replace(/^\(function \(global\) \{/, '(function (global) {')
    .replace(/\}\)\(window\);?\s*$/, '})(globalThis.__win);');
  sb.globalThis.__win = sb.window;
  vm.runInContext(code, vm.createContext(sb));
  return sb.window[exportsName];
}

// ---------- 1. 插件系统 ----------
{
  const sb = makeSandbox();
  sb.isTauriApp = () => false;
  const api = loadModule(sb, 'public/js/music/music_plugins.js', 'MusicPlugin');
  const MusicPlugin = api;

  MusicPlugin.initBuiltinMusicSources();
  const sources = MusicPlugin.listMusicSources();
  check('内置酷狗源已注册', sources.some(s => s.platform === '酷狗' && s.builtin));

  // 合法 MusicFree 风格插件
  const okCode = `
    module.exports = {
      platform: '测试源', version: '1.0.0',
      search: async (q, page) => ({ isEnd: true, data: [{ id: '1', title: '曲' + q, artist: '歌手', platform: '测试源' }] }),
      getMediaSource: async () => ({ url: 'https://example.com/a.mp3' })
    };`;
  const imported = MusicPlugin.importMusicPlugin(okCode);
  check('插件导入成功', imported.platform === '测试源' && !imported.replaced);
  const again = MusicPlugin.importMusicPlugin(okCode.replace("version: '1.0.0'", "version: '1.1.0'"));
  check('同名插件覆盖（不重复）', again.replaced && MusicPlugin.listMusicSources().filter(s => s.platform === '测试源').length === 1);

  // 危险插件拒绝
  let rejected = false;
  try { MusicPlugin.importMusicPlugin('module.exports = { platform: "坏", search: () => { while (true) {} } };'); }
  catch (e) { rejected = /死循环/.test(e.message); }
  check('死循环插件被拒绝', rejected);

  rejected = false;
  try { MusicPlugin.importMusicPlugin('module.exports = { foo: 1 };'); }
  catch (e) { rejected = /platform/.test(e.message); }
  check('缺 platform 的插件被拒绝', rejected);

  // 解析入口
  check('resolveMusicSource 走到插件', await (async () => {
    const r = await MusicPlugin.resolveMusicSource({ platform: '测试源', id: '1' });
    return r && r.url === 'https://example.com/a.mp3';
  })());

  // 禁用开关
  MusicPlugin.setSourceDisabled('测试源', true);
  check('禁用后 getEnabledMusicSources 不含该源',
    !MusicPlugin.getEnabledMusicSources().some(s => s.platform === '测试源'));
  MusicPlugin.setSourceDisabled('测试源', false);
  check('重新启用后恢复',
    MusicPlugin.getEnabledMusicSources().some(s => s.platform === '测试源'));

  // 删除
  MusicPlugin.removeMusicPlugin('测试源');
  check('删除后仅剩内置源', MusicPlugin.listMusicSources().length === 1);
}

// ---------- 2. LRC 解析 ----------
{
  const sb = makeSandbox();
  // music_lyrics.js 是 IIFE 挂到 window 的函数 + 顶层 const，需模拟 DOM 引用缺席下的加载
  sb.document = { getElementById: () => null, querySelectorAll: () => [], createElement: () => ({ style: {} }) };
  loadModule(sb, 'public/js/music/music_lyrics.js', 'musicLyrics');
  const parse = sb.parseLrcText;
  check('parseLrcText 已暴露', typeof parse === 'function');
  const lrc = '[ti:测试]\n[00:01.50]第一行\n[00:03.25][00:10.00]重复行\n[0:5]无小数位\n[00:99.999]毫秒三位';
  const lines = parse(lrc);
  check('LRC 行数（含多时间戳）', lines.length === 5);
  check('时间排序正确', lines[0].time === 1.5 && lines[1].time === 3.25 && lines[2].time === 5 && lines[3].time === 10 && Math.abs(lines[4].time - 99.999) < 0.001);
  check('标签剔除干净', lines.every(l => !l.text.includes('[') || l.text === ''));
  check('空输入安全', parse('').length === 0 && parse(null).length === 0);
}

// ---------- 3. 队列操作（music_core） ----------
{
  const sb = makeSandbox();
  const ctx = vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'public/js/music/music_core.js'), 'utf8'), ctx);
  vm.runInContext(`
    const a = { platform: 'x', id: '1', title: 'A' };
    const b = { platform: 'x', id: '2', title: 'B' };
    const c = { platform: 'x', id: '3', title: 'C' };
    musicQueueAppend(a); musicQueueAppend(b);
    musicQueueInsertNext(c); // 在 a(0) 后插入 → [a, c, b]
  `, ctx);
  check('append + insertNext 顺序正确', vm.runInContext('musicState.queue.map(q => q.title).join(",")', ctx) === 'A,C,B');
  vm.runInContext('musicQueueRemoveAt(0);', ctx);
  check('移除首位后 index 前移', vm.runInContext('musicState.queue.map(q => q.title).join(",") + "|" + musicState.index', ctx) === 'C,B|0');
  check('musicKey 归一', vm.runInContext('musicKey({platform:"x",id:"2"})', ctx) === 'x|2');
}

// ---------- 4. 酷狗字段映射（真实响应 fixture） ----------
{
  const fixture = {
    status: 1,
    data: {
      total: 2,
      lists: [{
        SongName: '<em>晴天</em>', SingerName: '周杰伦', AlbumName: '叶惠美',
        Image: 'http://imge.kugou.com/stdmusic/{size}/x.jpg',
        FileHash: 'HASH1', HQFileHash: 'HASHHQ1', AlbumID: '999', MixSongID: '123',
        Duration: 176, PayType: 0
      }]
    }
  };
  const sb = makeSandbox();
  sb.isTauriApp = () => false;
  const MusicPlugin = loadModule(sb, 'public/js/music/music_plugins.js', 'MusicPlugin');
  MusicPlugin.initBuiltinMusicSources();
  const source = MusicPlugin.getMusicSourceByPlatform('酷狗');
  // 劫持 _get 返回 fixture
  source._get = async () => JSON.stringify(fixture);
  const result = await source.search('晴天', 1, 'music');
  const item = result.data[0];
  check('搜索映射：标题去高亮标签', item.title === '晴天');
  check('搜索映射：歌手/专辑/封面', item.artist === '周杰伦' && item.album === '叶惠美' && item.artwork.includes('stdmusic/240/'));
  check('搜索映射：hash 与 id', item.hash === 'HASH1' && item.id === '123');
  check('isEnd 计算', result.isEnd === true); // 1*30 >= 2

  // 播放解析（模拟 playInfo 响应）
  source._get = async (url) => {
    if (url.includes('getSongInfo')) return JSON.stringify({ url: 'https://sharefs.test/a.mp3', fileSize: 100, bitRate: 128 });
    throw new Error('unexpected ' + url);
  };
  const media = await source.getMediaSource(item, 'standard');
  check('播放解析：直链', media.url === 'https://sharefs.test/a.mp3');
  // high 品质应使用 HQHash
  let usedHash = '';
  source._get = async (url) => { usedHash = url; return JSON.stringify({ url: 'https://sharefs.test/hq.mp3' }); };
  await source.getMediaSource(item, 'high');
  check('high 品质使用 HQHash', usedHash.includes('HASHHQ1'));
  // 无 url（付费内容）如实返回 null
  source._get = async () => JSON.stringify({ url: '' });
  check('平台未给地址 → null（不伪造）', await source.getMediaSource(item, 'standard') === null);

  // 歌词（base64 LRC）
  const lrcB64 = Buffer.from('[00:01.00]你好\n[00:03.00]世界', 'utf8').toString('base64');
  source._get = async (url) => {
    if (url.includes('krcs.kugou.com/search')) return JSON.stringify({ candidates: [{ id: 'L1', accesskey: 'K1' }] });
    if (url.includes('krcs.kugou.com/download')) return JSON.stringify({ content: lrcB64 });
    throw new Error('unexpected');
  };
  const lyric = await source.getLyric(item);
  check('歌词解码为 LRC 文本', lyric && lyric.rawLrc.includes('[00:01.00]你好'));
}

// ---------- 5. music.html 完整性 ----------
{
  const html = fs.readFileSync(path.join(ROOT, 'public/music.html'), 'utf8');
  const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map(m => m[1]);
  let missing = scripts.filter(src => !fs.existsSync(path.join(ROOT, 'public', src)));
  check('music.html 所有脚本存在（' + scripts.length + ' 个）', missing.length === 0);
  const cssLinks = [...html.matchAll(/href="([^"]+\.css)"/g)].map(m => m[1]);
  missing = cssLinks.filter(href => !fs.existsSync(path.join(ROOT, 'public', href)));
  check('music.html 所有样式存在', missing.length === 0);
  // JS 里引用的元素 id 必须在 HTML 里
  const jsIds = new Set();
  ['music_core', 'music_plugins', 'music_player', 'music_lyrics', 'music_download', 'music_search', 'music_ui']
    .forEach(name => {
      const js = fs.readFileSync(path.join(ROOT, 'public/js/music/' + name + '.js'), 'utf8');
      [...js.matchAll(/getElementById\('([^']+)'\)/g)].forEach(m => jsIds.add(m[1]));
    });
  const missingIds = [...jsIds].filter(id => !html.includes('id="' + id + '"'));
  check('JS 引用的元素 id 全部存在（' + jsIds.size + ' 个）', missingIds.length === 0);
  check('首页有音乐入口', fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8').includes("music.html"));
}

console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 全部通过');
process.exit(failed ? 1 : 0);
