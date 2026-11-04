// 端到端模拟：完整跑一遍 pickAndOpenLocalFile 真实流程
// 用真实的 local_file.js + 假的 Tauri invoke，验证参数传递与跳转 URL 是否正确
import fs from 'node:fs';
import vm from 'node:vm';

const ROOT = 'C:/Users/Administrator/WorkBuddy/2026-11-02-20-03-21/_upload_tmp';
const SRC = fs.readFileSync(`${ROOT}/public/js/local_file.js`, 'utf8');

let pass = 0, fail = 0;
function check(name, cond, extra = '') {
    if (cond) { pass++; console.log(`  ok   ${name}`); }
    else { fail++; console.log(`  FAIL ${name} ${extra}`); }
}

// 构造一个模拟浏览器 + Tauri 的沙箱
function makeEnv({ pickResult, invokeImpl }) {
    const toasts = [];
    const sb = {
        URLSearchParams,
        console,
        JSON,
        sessionStorage: { getItem: () => null, setItem: () => {} },
        window: { location: { search: '', href: '' } },
        document: { getElementById: () => null },
        showToast: (msg, type) => toasts.push({ msg, type }),
        isTauriApp: () => true,
        tauriInvoke: invokeImpl,
        // 记录跳转
        __navigatedTo: null
    };
    // location.href 赋值要被拦截 → 记录跳转目标
    const ctx = vm.createContext(sb);
    Object.defineProperty(sb.window.location, 'href', {
        get() { return sb.__navigatedTo || ''; },
        set(v) { sb.__navigatedTo = v; }
    });
    vm.runInContext(SRC, ctx);
    return { sb, ctx, toasts };
}

console.log('\n[E2E-1] 正常流程：选文件 → 起服务 → 跳转播放页');
{
    const calls = [];
    const { sb, ctx, toasts } = makeEnv({
        invokeImpl: async (cmd, args) => {
            calls.push({ cmd, args });
            if (cmd === 'pick_local_video') return '/storage/emulated/0/Movies/我的电影.mp4';
            if (cmd === 'start_local_file_server') {
                return {
                    url: 'http://192.168.1.5:8765/l/tok/我的电影.mp4',
                    loopback_url: 'http://127.0.0.1:8765/l/tok/我的电影.mp4',
                    token: 'tok'
                };
            }
            throw new Error('unexpected cmd ' + cmd);
        }
    });
    const ok = await ctx.pickAndOpenLocalFile();
    check('流程返回成功', ok === true);
    check('调用了 pick_local_video', calls.some(c => c.cmd === 'pick_local_video'));
    const slf = calls.find(c => c.cmd === 'start_local_file_server');
    check('起服务时传了文件路径', slf && slf.args.path === '/storage/emulated/0/Movies/我的电影.mp4');
    check('起服务时 preferredIp 为 null（只本机播放）', slf && slf.args.preferredIp === null);
    check('已跳转到播放页', !!sb.__navigatedTo, `=> ${sb.__navigatedTo}`);
    const p = new URLSearchParams(sb.__navigatedTo.split('?')[1]);
    check('跳转 URL 用回环地址', p.get('url') === 'http://127.0.0.1:8765/l/tok/我的电影.mp4');
    check('跳转带 local=1', p.get('local') === '1');
    check('跳转带 path（供投屏用）', p.get('path') === '/storage/emulated/0/Movies/我的电影.mp4');
    check('标题为文件名', p.get('title') === '我的电影.mp4', `=> ${p.get('title')}`);
}

console.log('\n[E2E-2] 用户取消：静默返回，不报错');
{
    const { sb, ctx, toasts } = makeEnv({
        invokeImpl: async (cmd) => {
            if (cmd === 'pick_local_video') return null; // 取消
            throw new Error('unexpected');
        }
    });
    const ok = await ctx.pickAndOpenLocalFile();
    check('取消返回 false', ok === false);
    check('取消不弹错误提示', toasts.filter(t => t.type === 'error').length === 0, JSON.stringify(toasts));
    check('取消不跳转', !sb.__navigatedTo);
}

console.log('\n[E2E-3] 插件 reject "File picker cancelled"：同样静默');
{
    const { sb, ctx, toasts } = makeEnv({
        invokeImpl: async () => { throw new Error('File picker cancelled'); }
    });
    const ok = await ctx.pickAndOpenLocalFile();
    check('reject 取消返回 false', ok === false);
    check('reject 取消不弹错误提示', toasts.filter(t => t.type === 'error').length === 0, JSON.stringify(toasts));
}

console.log('\n[E2E-4] 选文件真失败：弹错误提示');
{
    const { sb, ctx, toasts } = makeEnv({
        invokeImpl: async () => { throw new Error('文件选择任务失败: boom'); }
    });
    const ok = await ctx.pickAndOpenLocalFile();
    check('失败返回 false', ok === false);
    const err = toasts.find(t => t.type === 'error');
    check('弹出错误提示', !!err, JSON.stringify(toasts));
    check('错误信息带原因', err && /boom/.test(err.msg), `=> ${err && err.msg}`);
}

console.log('\n[E2E-5] 起服务失败：弹错误提示，不跳转');
{
    const { sb, ctx, toasts } = makeEnv({
        invokeImpl: async (cmd) => {
            if (cmd === 'pick_local_video') return '/a/b.mp4';
            throw new Error('端口绑定失败');
        }
    });
    const ok = await ctx.pickAndOpenLocalFile();
    check('失败返回 false', ok === false);
    check('弹错误提示', toasts.some(t => t.type === 'error' && /端口绑定失败/.test(t.msg)), JSON.stringify(toasts));
    check('失败不跳转', !sb.__navigatedTo);
}

console.log('\n[E2E-6] 服务返回空 loopback_url：拦截');
{
    const { sb, ctx, toasts } = makeEnv({
        invokeImpl: async (cmd) => {
            if (cmd === 'pick_local_video') return '/a/b.mp4';
            return { url: 'x', loopback_url: '', token: 't' };
        }
    });
    const ok = await ctx.pickAndOpenLocalFile();
    check('空地址返回 false', ok === false);
    check('弹错误提示', toasts.some(t => t.type === 'error'), JSON.stringify(toasts));
    check('不跳转', !sb.__navigatedTo);
}

console.log('\n[E2E-7] 网页版（无 Tauri）：提示仅限 App 内');
{
    const sb = {
        URLSearchParams, console, JSON,
        sessionStorage: { getItem: () => null, setItem: () => {} },
        window: { location: { search: '', href: '' } },
        document: { getElementById: () => null },
        toasts: [],
        showToast(msg, type) { sb.toasts.push({ msg, type }); },
        isTauriApp: () => false,
        tauriInvoke: async () => { throw new Error('should not be called'); }
    };
    const ctx = vm.createContext(sb);
    Object.defineProperty(sb.window.location, 'href', { get() { return ''; }, set() { sb.__navigated = true; } });
    vm.runInContext(SRC, ctx);
    const ok = await ctx.pickAndOpenLocalFile();
    check('网页版返回 false', ok === false);
    check('提示仅限 App 内使用', sb.toasts.some(t => /仅限 App 内/.test(t.msg)), JSON.stringify(sb.toasts));
}

console.log('\n[E2E-8] Android content:// 路径：跳转参数完整');
{
    const contentUri = 'content://com.android.providers.media.documents/document/video%3A99887';
    const { sb, ctx } = makeEnv({
        invokeImpl: async (cmd) => {
            if (cmd === 'pick_local_video') return contentUri;
            return { url: 'http://192.168.1.5:9/l/t/video.mp4', loopback_url: 'http://127.0.0.1:9/l/t/video.mp4', token: 't' };
        }
    });
    await ctx.pickAndOpenLocalFile();
    const p = new URLSearchParams(sb.__navigatedTo.split('?')[1]);
    check('content URI 原样传给 path', p.get('path') === contentUri, `=> ${p.get('path')}`);
    check('content URI 场景也带 local=1', p.get('local') === '1');
    // 特殊字符必须被正确编码，参数结构不破
    check('参数个数正确（无串位）', [...p.keys()].length === 7, `keys=${[...p.keys()].join(',')}`);
    check('url 参数未被 content URI 污染', p.get('url') === 'http://127.0.0.1:9/l/t/video.mp4');
}

console.log(`\n===== ${pass} passed, ${fail} failed =====`);
process.exit(fail ? 1 : 0);
