// 本地视频文件：选文件 → 本机起 HTTP 服务 → 跳转独立播放页播放。
//
// 与 player_cast.js 里的「本地视频播放」（齿轮菜单项）不同：那一项是在当前播放器实例内
// 切换 URL，必须先有播放器才能用；这里走独立播放页，从首页就能直接进入，不必先播别的视频。
//
// 注意（Android）：tauri-plugin-dialog 用 ACTION_GET_CONTENT 取文件，拿到的 content://
// URI 权限不跨进程重启保留，且本地文件服务是内存态（token→文件引用存在进程内）。
// 因此本地文件不适合做成「最近播放」列表——重启后条目必然失效。这里只做一次性播放。

// 本地文件播放页 URL 上的标记：player.html 据此知道这是本地文件，从而不写入观看历史
// （历史里的 127.0.0.1 条目重启即失效，属于脏数据）。
// 值必须是 '1'/'true'，与 isLocalFileMode() 的判定保持一致。
const LOCAL_FILE_FLAG = '1';

function isTauriRuntime() {
    return typeof isTauriApp === 'function' && isTauriApp();
}

function localFileErrorText(e) {
    if (!e) return '未知错误';
    if (typeof e === 'string') return e;
    if (e && typeof e.message === 'string' && e.message) return e.message;
    return String(e);
}

// 从路径/URI 里取出可读的文件名，用作播放页标题。
// content:// URI 的末段通常是文档 id（含扩展名），但也可能被编码过。
function localFileDisplayName(rawPath) {
    const path = String(rawPath || '');
    let name = path;
    try {
        name = decodeURIComponent(path);
    } catch (e) { /* 保留原串，解码失败不影响流程 */ }
    const cut = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'));
    if (cut >= 0 && cut < name.length - 1) name = name.slice(cut + 1);
    name = name.trim();
    // Android 的 content URI 末段可能是 "primary:Download/xxx.mp4" 这类复合 id：
    // 冒号后面还带路径，切掉前缀才能拿到文件名。
    // 但 "video:12345" 这种冒号后是纯数字 id 的，切了反而丢掉有意义的部分。
    // 判据：切分结果必须仍带扩展名，否则保留原样。
    const semi = name.lastIndexOf(':');
    if (semi >= 0 && semi < name.length - 1) {
        const after = name.slice(semi + 1);
        const afterSlash = after.slice(after.lastIndexOf('/') + 1);
        if (/\.[A-Za-z0-9]{1,4}$/.test(afterSlash)) {
            name = afterSlash;
        }
    }
    return name || '本地视频';
}

// 组装本地文件播放页 URL。
// local=1 让 player.html 走「本地模式」：不写观看历史、不做在线换源。
// path 一并带上：投屏时需要它来起 LAN 地址（回环地址电视访问不到）。
// 走 URL 参数而非 sessionStorage —— index.html → player.html 是整页跳转，
// sessionStorage 不跨页面共享，存了也读不到。
function buildLocalFilePlayerUrl(loopbackUrl, title, path) {
    const params = new URLSearchParams({
        url: String(loopbackUrl || ''),
        title: String(title || '本地视频'),
        source: '本地文件',
        source_code: '',
        index: '0',
        local: LOCAL_FILE_FLAG,
        path: String(path || '')
    });
    return `player.html?${params.toString()}`;
}

// 选文件 → 起服务 → 跳转播放页。全流程走 Tauri 命令，网页版无此能力。
// 返回 true 表示已成功跳转；false 表示用户取消或流程失败（失败原因已提示）。
async function pickAndOpenLocalFile() {
    if (!isTauriRuntime() || typeof tauriInvoke !== 'function') {
        showToast('本地文件播放仅限 App 内使用', 'warning');
        return false;
    }

    let path = null;
    try {
        path = await tauriInvoke('pick_local_video', {});
    } catch (e) {
        // 用户取消时插件会 reject，这不算错误，不弹提示
        const text = localFileErrorText(e);
        if (/cancel/i.test(text)) return false;
        showToast('文件选择失败：' + text, 'error');
        return false;
    }
    if (!path) return false; // 用户取消

    showToast('正在准备本地文件…', 'info');
    let entry = null;
    try {
        // preferredIp 传 null：只在本机播放，不需要局域网地址
        entry = await tauriInvoke('start_local_file_server', { path: path, preferredIp: null });
    } catch (e) {
        showToast('本地文件服务失败：' + localFileErrorText(e), 'error');
        return false;
    }
    if (!entry || !entry.loopback_url) {
        showToast('本地文件服务未返回可播地址', 'error');
        return false;
    }

    // start_local_file_server 只返回 url/loopback_url/token，没有文件名，标题从原始路径推导
    const title = localFileDisplayName(path);
    window.location.href = buildLocalFilePlayerUrl(entry.loopback_url, title, path);
    return true;
}

// 本地文件模式：player.html?local=1
// 本地文件的 URL 是本机回环地址（127.0.0.1/l/<token>/...），token 存在进程内存里，
// App 重启后立即失效。因此本地文件既不能进观看历史（会留下点不开的死链），
// 也不该留下进度记录（同一批 localStorage 键会随每次选文件不断累积）。
// 首页也加载本文件，但首页没有 currentVideoUrl，兜底判断要防未定义。
function isLocalFileMode() {
    try {
        const flag = new URLSearchParams(window.location.search).get('local');
        if (flag === '1' || flag === 'true') return true;
    } catch (e) { /* ignore */ }
    // 兜底：URL 指向本机回环地址，同样按本地文件处理
    const cur = typeof currentVideoUrl === 'string' ? currentVideoUrl : '';
    return /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/i.test(cur);
}

// 读取当前播放的本地文件原始路径（非本地模式返回空串）
function getLocalFilePath() {
    try {
        if (!isLocalFileMode()) return '';
        return new URLSearchParams(window.location.search).get('path') || '';
    } catch (e) {
        return '';
    }
}

// 首页入口图标：仅 Tauri 环境显示（网页版没有系统文件选择器，按钮无意义）
function setupLocalFileEntry() {
    const btn = document.getElementById('localFileBtn');
    if (!btn) return;
    if (!isTauriRuntime()) {
        btn.classList.add('hidden');
        return;
    }
    btn.classList.remove('hidden');
    btn.addEventListener('click', function (e) {
        e.stopPropagation();
        pickAndOpenLocalFile();
    });
}
