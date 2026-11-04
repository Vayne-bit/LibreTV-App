// 本地文件独立入口的离线回归验证
// 覆盖：文件名推导、播放页 URL 组装、本地模式判定、投屏路径读取、历史写入拦截
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = 'C:/Users/Administrator/WorkBuddy/2026-11-02-20-03-21/_upload_tmp';
const SRC = fs.readFileSync(`${ROOT}/public/js/local_file.js`, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

// ---------- 1. 文件名推导 ----------
console.log('\n[1] localFileDisplayName');
const nameSandbox = { URLSearchParams, decodeURIComponent, console };
{
    const ctx = vm.createContext(nameSandbox);
    vm.runInContext(SRC, ctx);
    const f = nameSandbox.localFileDisplayName;
    check('磁盘路径取文件名', f('/storage/emulated/0/Movies/测试影片.mp4') === '测试影片.mp4', `=> ${f('/storage/emulated/0/Movies/测试影片.mp4')}`);
    check('content URI 复合 id 保留有意义部分', f('content://com.android.providers.media.documents/document/video%3A12345') === 'video:12345', `=> ${f('content://com.android.providers.media.documents/document/video%3A12345')}`);
    check('含冒号的复合 id 再切一次', f('content://x/document/primary:Download/a.mp4') === 'a.mp4', `=> ${f('content://x/document/primary:Download/a.mp4')}`);
    check('空输入兜底', f('') === '本地视频', `=> ${f('')}`);
    check('Windows 路径', f('C:\\Users\\me\\videos\\a.mp4') === 'a.mp4', `=> ${f('C:\\Users\\me\\videos\\a.mp4')}`);
    check('无扩展名也返回可读名', f('/a/b/无扩展名') === '无扩展名', `=> ${f('/a/b/无扩展名')}`);
}

// ---------- 2. 播放页 URL 组装 ----------
console.log('\n[2] buildLocalFilePlayerUrl');
{
    const ctx = vm.createContext({ URLSearchParams, console });
    vm.runInContext(SRC, ctx);
    const url = ctx.buildLocalFilePlayerUrl('http://127.0.0.1:8765/l/tok/a.mp4', '我的视频.mp4', '/storage/Movies/a.mp4');
    console.log('     =>', url);
    const p = new URLSearchParams(url.split('?')[1]);
    check('url 参数指向回环地址', p.get('url') === 'http://127.0.0.1:8765/l/tok/a.mp4');
    check('local 标记为 1', p.get('local') === '1');
    check('path 带上原始路径', p.get('path') === '/storage/Movies/a.mp4');
    check('title 保留中文', p.get('title') === '我的视频.mp4');
    check('source 标为本地文件', p.get('source') === '本地文件');
    // 关键：path 含 & ? # 等特殊字符时不能破坏参数结构
    const tricky = 'content://x/doc/a&b=c?d#e.mp4';
    const url2 = ctx.buildLocalFilePlayerUrl('http://127.0.0.1:1/l/t/a.mp4', 't', tricky);
    const p2 = new URLSearchParams(url2.split('?')[1]);
    check('特殊字符路径不破坏参数', p2.get('path') === tricky, `=> ${p2.get('path')}`);
}

// ---------- 3. 本地模式判定 ----------
console.log('\n[3] isLocalFileMode');
function modeSandbox(search, curUrl) {
    const sb = {
        URLSearchParams,
        console,
        window: { location: { search } },
        currentVideoUrl: curUrl
    };
    const ctx = vm.createContext(sb);
    vm.runInContext(SRC, ctx);
    return ctx.isLocalFileMode();
}
check('local=1 判定为本地模式', modeSandbox('?local=1&url=x', '') === true);
check('local=true 判定为本地模式', modeSandbox('?local=true', '') === true);
check('无 local 且非回环 → 非本地', modeSandbox('?url=https://a/b.m3u8', 'https://a/b.m3u8') === false);
check('无 local 但 URL 是回环 → 兜底判本地', modeSandbox('?url=x', 'http://127.0.0.1:8765/l/t/a.mp4') === true);
check('localhost 回环也判本地', modeSandbox('?url=x', 'http://localhost:8765/l/t/a.mp4') === true);
check('首页无 currentVideoUrl 不报错', modeSandbox('', undefined) === false);

// ---------- 4. getLocalFilePath ----------
console.log('\n[4] getLocalFilePath');
function pathSandbox(search, curUrl) {
    const sb = {
        URLSearchParams, console,
        window: { location: { search } },
        currentVideoUrl: curUrl
    };
    const ctx = vm.createContext(sb);
    vm.runInContext(SRC, ctx);
    return ctx.getLocalFilePath();
}
check('本地模式取到 path', pathSandbox('?local=1&path=%2Fs%2Fa.mp4', 'http://127.0.0.1:1/l/t/a.mp4') === '/s/a.mp4');
check('非本地模式返回空串', pathSandbox('?url=https://a/b.m3u8', 'https://a/b.m3u8') === '');

// ---------- 5. 历史写入拦截 ----------
console.log('\n[5] saveToHistory / saveCurrentProgress 拦截');
{
    const utils = fs.readFileSync(`${ROOT}/public/js/player_utils.js`, 'utf8');
    // 与真实页面一致：player.html 先载 player_utils.js，再载 local_file.js
    // （saveToHistory 在调用时才取 isLocalFileMode，加载顺序不影响，但这里如实模拟）
    const mkCtx = (search, curUrl) => {
        const sb = {
            URLSearchParams, console, JSON,
            localStorage: { getItem: () => null, setItem: () => {} },
            window: { location: { search } },
            currentVideoUrl: curUrl,
            currentEpisodes: [curUrl],
            currentEpisodeIndex: 0, currentEpisodeNames: [],
            currentVideoTitle: '本地视频', art: null, progressSaveInterval: null
        };
        const ctx = vm.createContext(sb);
        vm.runInContext(utils, ctx);
        vm.runInContext(SRC, ctx);
        return { sb, ctx };
    };

    const { sb, ctx } = mkCtx('?local=1', 'http://127.0.0.1:8765/l/t/a.mp4');
    let wrote = false;
    sb.localStorage = { getItem: (k) => (k === 'viewingHistory' ? '[]' : null), setItem: (k, v) => { if (k === 'viewingHistory') wrote = true; } };
    ctx.saveToHistory();
    check('本地模式不写观看历史', wrote === false, `wrote=${wrote}`);
    let wroteProgress = false;
    sb.localStorage = { getItem: () => null, setItem: (k, v) => { if (String(k).startsWith('videoProgress_')) wroteProgress = true; } };
    ctx.saveCurrentProgress();
    check('本地模式不写播放进度', wroteProgress === false, `wroteProgress=${wroteProgress}`);
    // 非本地模式应正常写入：在线场景必须同时改 URL 参数和 currentVideoUrl 全局变量
    const r2 = mkCtx('?url=https://a/b.m3u8', 'https://a/b.m3u8');
    let wrote2 = false;
    r2.sb.localStorage = { getItem: (k) => (k === 'viewingHistory' ? '[]' : null), setItem: (k) => { if (k === 'viewingHistory') wrote2 = true; } };
    r2.ctx.saveToHistory();
    check('在线模式仍正常写历史', wrote2 === true, `wrote2=${wrote2}`);
}

// ---------- 6. 页面结构：入口按钮与脚本挂载 ----------
console.log('\n[6] 页面结构');
{
    const indexHtml = fs.readFileSync(`${ROOT}/public/index.html`, 'utf8');
    const playerHtml = fs.readFileSync(`${ROOT}/public/player.html`, 'utf8');
    check('index.html 有 localFileBtn', indexHtml.includes('id="localFileBtn"'));
    check('入口按钮默认 hidden（网页版不显示）', /id="localFileBtn"[^>]*class="[^"]*hidden/.test(indexHtml));
    check('index.html 引入 local_file.js', indexHtml.includes('js/local_file.js'));
    check('player.html 引入 local_file.js', playerHtml.includes('js/local_file.js'));
    const appInit = fs.readFileSync(`${ROOT}/public/js/app_init.js`, 'utf8');
    check('app_init 挂载 setupLocalFileEntry', appInit.includes('setupLocalFileEntry'));
    // 脚本顺序：local_file.js 必须在 player_cast.js 之前（投屏要用 getLocalFilePath）
    const iLocal = playerHtml.indexOf('js/local_file.js');
    const iCast = playerHtml.indexOf('js/player_cast.js');
    check('player.html 中 local_file.js 先于 player_cast.js', iLocal > -1 && iCast > -1 && iLocal < iCast, `local=${iLocal} cast=${iCast}`);
    // 入口按钮不应带 data-go，避免被全局导航委托捕获
    const btnLine = indexHtml.split('\n').find(l => l.includes('id="localFileBtn"')) || '';
    check('入口按钮不带 data-go', !btnLine.includes('data-go'), btnLine.trim());
}

// ---------- 7. 投屏：本地模式用 LAN 地址而非回环地址 ----------
console.log('\n[7] 投屏走 LAN 地址');
{
    const cast = fs.readFileSync(`${ROOT}/public/js/player_cast.js`, 'utf8');
    check('toggleDlna 读取本地路径', cast.includes('getLocalFilePath'));
    check('本地路径传入 chooseDeviceThenCast', /localPath[\s\S]{0,200}chooseDeviceThenCast\(url, currentReferer\(\), true, localPath\)/.test(cast));
    check('本地模式不重切本机 URL', cast.includes('isLocalFileMode'));
    const onChosen = cast.slice(cast.indexOf('function onDeviceChosen'));
    check('本地投屏用 entry.url（LAN 地址）', onChosen.includes('castUrlToDevice(device, entry.url'));
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
