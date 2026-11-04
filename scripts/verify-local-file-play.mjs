// 本地视频播放链路实证验证
//
// 背景：用户反馈「新的版本播放本地文件不成功，能弹窗选文件，点击后播放器没变化」。
//
// 根因假设：artplayer 的 url setter 逻辑是
//     n = option.type || V(新地址)
// option.type 在实例初始化时固定（本 App 初始是 m3u8），换 URL 时不重算。
// 于是本地 mp4 被送进 customType['m3u8'] = playM3u8（hls.js），
// hls.js 解析不了 mp4 → 报错被 switchUrl 的 Promise 吞掉 → 播放器毫无变化。
//
// 本脚本直接加载项目里真实的 artplayer 库与真实的 player_cast.js 源码，
// 用一个最小 DOM 替身驱动真实的 url setter，验证：
//   1) 裸调 switchUrl → 走 playM3u8（错误路径）
//   2) 修复后的 switchPlayerTo → 走原生 video.src（正确路径）
//
// 用法：node scripts/verify-local-file-play.mjs

import fs from 'fs';
import path from 'path';
import vm from 'vm';

const ROOT = process.cwd();

// ---------------------------------------------------------------- 环境替身
// artplayer 依赖 document/window 等，这里给一个够用的最小替身：
// 记录 video.src 的赋值，以及 customType 哪个分支被走到。
function makeEnv(label) {
    const log = { label, src: '', customTypeUsed: null, typeResolved: null, error: null };
    const video = {
        _src: '',
        get src() { return this._src; },
        set src(v) { this._src = v; log.src = v; },
        canPlayType: () => '',
        play: () => Promise.resolve(),
        pause: () => {},
        addEventListener: () => {},
        removeEventListener: () => {}
    };
    const sandbox = {
        console, URL, Date, Set, Map, Math, JSON, parseFloat, parseInt, isNaN,
        Object, Array, Number, String, RegExp, Promise, Error,
        setTimeout, clearTimeout, setInterval, clearInterval,
        localStorage: {
            _d: {},
            getItem(k) { return this._d[k] === undefined ? null : this._d[k]; },
            setItem(k, v) { this._d[k] = String(v); }
        },
        document: {
            createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, click() {} }),
            addEventListener: () => {},
            removeEventListener: () => {},
            querySelector: () => null,
            querySelectorAll: () => [],
            body: { appendChild() {}, removeChild() {}, classList: { toggle() {}, add() {}, remove() {} } },
            documentElement: { style: {} },
            visibilityState: 'visible'
        },
        navigator: { userAgent: 'node', mediaDevices: { getUserMedia: () => Promise.resolve() } },
        location: { href: 'http://localhost/', protocol: 'http:', host: 'localhost' },
        screen: { width: 1280, height: 800 },
        devicePixelRatio: 1,
        Image: function () {},
        XMLHttpRequest: function () {},
        __log: log,
        __video: video
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.self = sandbox;
    return { sandbox, log, video };
}

// ------------------------------------------------- 抽取 artplayer 的 url setter
// 从压缩库里取出决定分支的那段逻辑，用真实源码而不是手写复现。
function extractUrlSetter(artplayerSrc) {
    const marker = 'n=e.type||V(a)';
    const mi = artplayerSrc.indexOf(marker);
    if (mi < 0) throw new Error('未在 artplayer 库里找到 url setter 的分支表达式');
    // 往前找到 async set(a){ 的开头
    const start = artplayerSrc.lastIndexOf('async set(a){', mi);
    // 往后找到该 set 函数的结束（用括号配平）
    let depth = 0;
    let i = artplayerSrc.indexOf('{', start);
    for (; i < artplayerSrc.length; i++) {
        const ch = artplayerSrc[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return artplayerSrc.slice(start, i);
}

// ---------------------------------------------- 模拟 artplayer 实例（真实分支逻辑）
// 用从库里抽出的真实 setter 表达式来驱动，验证 option.type 是否生效。
function makeArtplayer(artplayerSrc, env) {
    const setterSrc = extractUrlSetter(artplayerSrc);
    const log = env.log;

    // V(a)：从地址推导类型，规则与项目 getVideoType 一致
    const V = (a) => {
        const p = String(a || '').split('?')[0].toLowerCase();
        if (p.endsWith('.flv')) return 'flv';
        if (/\.(mp4|webm|mkv|mov|m4v)$/.test(p)) return p.split('.').pop();
        return 'm3u8';
    };
    // 把真实 setter 里的关键表达式改成可观测版本（分支判定逻辑原样保留）
    // 注意：替换文本不能含分号 —— setter 里的三元分支不允许语句块
    const observable = setterSrc
        .replace('n=e.type||V(a)', 'n=e.type||__V(a)')
        .replace('i.call(t,r,a,t)', '(__log.customTypeUsed=n, __log.typeResolved=n, i.call(t,r,a,t))')
        .replace('r.src=a', '(__log.customTypeUsed=null, __log.typeResolved=(n||"native"), r.src=a)');

    const instance = {
        option: { type: 'm3u8', customType: { m3u8: 'playM3u8', flv: 'playFlv' } },
        template: { $video: env.video },
        loading: { show: false },
        isReady: false,
        notice: { show: '' },
        once: () => {},
        off: () => {},
        emit: () => {},
        url: ''
    };
    // option.customType 的值必须可调用（setter 里 i.call(t,r,a,t)），
    // 用记录函数代替，命中即说明走了 customType 分支
    instance.option.customType = {
        m3u8: function () { log.customTypeCalled = 'm3u8'; },
        flv: function () { log.customTypeCalled = 'flv'; }
    };

    // 定义 url 的存取器（对齐真实 artplayer 的 url getter/setter）
    Object.defineProperty(instance, 'url', {
        get() { return this.template.$video.src; },
        set(v) { this._setUrl(v); },
        configurable: true
    });
    // 把真实 setter 变成可调用的函数体。
    // 压缩库里是 "async set(a){...}" 的方法简写，直接当语句/字面量都不合法；
    // 这里剥掉方法名，只留函数体，用 new Function 构造（不受字面量语法限制）。
    const bodyOnly = observable.replace(/^async set\(a\)\{/, '').replace(/\}\s*$/, '');
    const factory = new Function(
        't', 'e', 'r', 'Z', '__V', '__log',
        'return async function(a){' + bodyOnly + '}'
    );
    instance._setUrl = factory(instance, instance.option, env.video, async () => {}, V, log);
    return instance;
}

// ------------------------------------------------- 抽取项目里的 getVideoType
function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('未找到函数 ' + name);
    let depth = 0;
    let i = src.indexOf('{', start);
    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '{') depth++;
        else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
    }
    return src.slice(start, i);
}

// ------------------------------------------------------------------ 主流程
const artplayerSrc = fs.readFileSync(path.join(ROOT, 'public/libs/artplayer.js'), 'utf8');
const handlerSrc = fs.readFileSync(path.join(ROOT, 'public/js/player_artplayer_handler.js'), 'utf8');
const castSrc = fs.readFileSync(path.join(ROOT, 'public/js/player_cast.js'), 'utf8');

const LOCAL_URL = 'http://127.0.0.1:34567/l/tok123/movie.mp4';
const M3U8_URL = 'https://example.com/hls/index.m3u8';

let failures = 0;
function check(cond, label, detail) {
    if (cond) {
        console.log('  ✅ ' + label);
    } else {
        failures++;
        console.log('  ❌ ' + label + (detail ? '  → ' + detail : ''));
    }
}

console.log('=== 1. 修复前：裸调 switchUrl（option.type 停留在 m3u8）===');
{
    const env = makeEnv('before');
    const { sandbox, log } = env;
    const art = makeArtplayer(artplayerSrc, env);
    // 模拟裸调 switchUrl：只设 video.src，不改 option.type
    art.template.$video.src = M3U8_URL;   // 先播 m3u8
    art.option.type = 'm3u8';
    // 裸调：只触发 url setter
    // 注意：artplayer 的 url setter 是 async（内部 await Z() 销毁旧引擎），
    // 必须等它跑完才能读到分支结果
    await art._setUrl(LOCAL_URL);
    console.log('  option.type =', art.option.type);
    console.log('  实际走到的分支 =', log.customTypeUsed === null ? '原生 video.src' : 'customType:' + log.customTypeUsed);
    check(log.customTypeUsed === 'm3u8',
        '修复前确认：mp4 被送进 playM3u8（hls.js），这正是「播放器没变化」的成因',
        '实际分支 ' + log.customTypeUsed);
}

console.log('\n=== 2. 修复后：switchPlayerTo 先按新地址重算 type ===');
{
    const env = makeEnv("after");
    const { sandbox, log } = env;
    const art = makeArtplayer(artplayerSrc, env);
    art.template.$video.src = M3U8_URL;
    art.option.type = 'm3u8';

    // 用项目里真实的 getVideoType 推导
    const ctx = vm.createContext(sandbox);
    vm.runInContext(extractFunction(handlerSrc, 'getVideoType') + '\nglobalThis.__getVideoType = getVideoType;', ctx);
    const getVideoType = vm.runInContext('globalThis.__getVideoType', ctx);

    const type = getVideoType(LOCAL_URL);
    art.option.type = type;
    await art._setUrl(LOCAL_URL);
    console.log('  option.type =', art.option.type);
    console.log('  实际走到的分支 =', log.customTypeUsed === null ? '原生 video.src' : 'customType:' + log.customTypeUsed);
    check(type === 'mp4', '本地 mp4 被正确识别为 mp4 类型', '得到 ' + type);
    check(log.customTypeUsed === null && log.src === LOCAL_URL,
        '修复后：走原生 video.src，video.src 已指向本地文件',
        'src=' + log.src + ' customType=' + log.customTypeUsed);
}

console.log('\n=== 3. switchPlayerTo 的实现检查（源码层面）===');
{
    // 确认 player_cast.js 里的 switchPlayerTo 做了三件关键事
    const bodyMatch = castSrc.match(/function switchPlayerTo\(url, art\) \{[\s\S]*?\n    \}/);
    const body = bodyMatch ? bodyMatch[0] : '';
    check(body.length > 0, 'player_cast.js 存在 switchPlayerTo 函数');
    check(/option\.type\s*=/.test(body), '设置了 player.option.type（按新地址重算类型）');
    check(/destroyStreamEngines/.test(body), '切到非 m3u8/flv 时销毁旧解流引擎');
    check(/switchUrl\(/.test(body), '调用了 switchUrl');
    check(/\.catch\(/.test(body), '捕获了 switchUrl 的 Promise 拒绝（否则报错被吞）');

    // 确认没有遗留的裸 switchUrl 调用（switchPlayerTo 自身的调用不算）
    // 用行号区间排除：switchPlayerTo 的函数体行号范围
    const fnStart = castSrc.split('\n').findIndex(l => /function switchPlayerTo\(/.test(l));
    const fnEnd = castSrc.split('\n').findIndex((l, i) => i > fnStart && /^\s{4}\}/.test(l));
    const bareCalls = [];
    castSrc.split('\n').forEach((line, i) => {
        if (!/\.switchUrl\(/.test(line)) return;
        if (i >= fnStart && i <= fnEnd) return;   // switchPlayerTo 内部的调用合法
        bareCalls.push((i + 1) + ': ' + line.trim());
    });
    check(bareCalls.length === 0, 'player_cast.js 内无遗留裸 switchUrl 调用',
        bareCalls.join(' | '));

    // 确认 switchPlayerTo 的函数体内部确实有 switchUrl 调用（证明上面的排除没有误伤）
    check(/player\.switchUrl\(/.test(body), 'switchPlayerTo 内部确实调用了 switchUrl（排除规则无误伤）');

    // 确认四处调用点都走了 switchPlayerTo
    const callCount = (castSrc.match(/switchPlayerTo\(/g) || []).length;
    check(callCount >= 4, '四处调用点（本地播放/投屏本地/VIP URL/VIP 关键词）均已改用 switchPlayerTo',
        '找到 ' + callCount + ' 处');
}

console.log('\n=== 4. 服务端能力检查（本地文件服务是否满足播放要求）===');
{
    const rustSrc = fs.readFileSync(path.join(ROOT, 'src-tauri/src/dlna.rs'), 'utf8');
    check(/Accept-Ranges: bytes/.test(rustSrc), '本地文件服务声明了 Accept-Ranges: bytes（可拖拽进度）');
    check(/206 Partial Content/.test(rustSrc), '支持 206 Partial Content（分段请求）');
    check(/content-range/i.test(rustSrc), '回传 Content-Range 头');
    check(/Some\("mp4"\)\s*\|\s*Some\("m4v"\)/.test(rustSrc), 'mp4 的 MIME 映射正确');
    check(/fn extract_fname_from_content_uri/.test(rustSrc), 'Android content:// 文件名提取已实现（URL 带正确扩展名）');
    // loopback_url 必须含扩展名，否则 type 推导会退回 m3u8
    check(/loopback_url:\s*String/.test(rustSrc), '返回 loopback_url');
    check(/format!\("http:\/\/127\.0\.0\.1:\{\}\/l\/\{\}\/\{\}"/.test(rustSrc),
        'loopback_url 形如 http://127.0.0.1:port/l/token/name.ext（扩展名保留）');
}

console.log('\n=== 5. 跨脚本可见性（player_cast.js 先加载）===');
{
    // player_cast.js 在 player.html 里先于 player_artplayer_handler.js 加载，
    // 但 switchPlayerTo 是在运行时（用户点击时）才调用 destroyStreamEngines/getVideoType，
    // 那时 handler 已加载完 —— 经典 <script> 的函数声明挂在全局作用域，跨脚本可见。
    const sandbox = {
        console, URL, Set, Map, Date, JSON, Math, Object, Array, String, Number, RegExp,
        isNaN, parseFloat, parseInt, Promise, Error, setTimeout, clearTimeout
    };
    sandbox.window = sandbox; sandbox.globalThis = sandbox; sandbox.self = sandbox;
    sandbox.document = {
        createElement: () => ({ style: {} }), addEventListener() {}, removeEventListener() {},
        querySelector: () => null, querySelectorAll: () => [],
        body: { classList: { toggle() {}, add() {}, remove() {} } }, documentElement: { style: {} }
    };
    sandbox.navigator = { userAgent: 'node' };
    sandbox.location = { href: 'http://localhost/' };
    const ctx = vm.createContext(sandbox);
    vm.runInContext(castSrc, ctx);
    // handler 里 getAndroidBridge 依赖未注入，加载会中断在那一行；
    // 但 destroyStreamEngines / getVideoType 都是顶层函数声明，已经完成定义。
    try { vm.runInContext(handlerSrc, ctx); } catch (e) { /* 依赖缺失中断，不影响已定义的函数 */ }

    const destroyType = vm.runInContext('typeof destroyStreamEngines', ctx);
    const typeType = vm.runInContext('typeof getVideoType', ctx);
    check(destroyType === 'function',
        'destroyStreamEngines 跨脚本可见（player_cast.js 能调用它销毁旧 hls 实例）',
        'typeof = ' + destroyType);
    check(typeType === 'function',
        'getVideoType 跨脚本可见（player_cast.js 能按新地址推导类型）',
        'typeof = ' + typeType);
}

console.log('\n' + (failures === 0
    ? '✅ 全部通过：本地视频播放链路的类型判定问题已定位并修复'
    : '❌ 有 ' + failures + ' 项未通过'));
process.exit(failures === 0 ? 0 : 1);
