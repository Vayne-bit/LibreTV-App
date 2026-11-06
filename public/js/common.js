// Shared helpers for index.html and player.html

const NO_COVER_IMAGE = 'image/nomedia.png';

function escapeHtml(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isTauriApp() {
    return !!(window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === 'function');
}

function tauriInvoke(command, args) {
    if (!isTauriApp()) return Promise.reject(new Error('Tauri API unavailable'));
    return window.__TAURI_INTERNALS__.invoke(command, args || {});
}

function getAndroidBridge() {
    return window.LibreTVAndroid || null;
}

// Android 网络变化（Wi-Fi 切换/熄屏后恢复/流量切换）→ 重建 Rust 上游
// HTTP 客户端，丢弃可能已被系统黑洞的连接池（熄屏断流修复的一环：
// 真机实证池内死连接会让亮屏后的首个请求继续超时）。由 MainActivity 的
// registerDefaultNetworkCallback 触发。
window.__libretvNetworkChanged = function () {
    try {
        if (typeof isTauriApp === 'function' && isTauriApp() && typeof tauriInvoke === 'function') {
            tauriInvoke('reset_http_client').catch(function () { /* 静默 */ });
        }
    } catch (e) { /* 非安卓环境忽略 */ }
    return true;
};

// Tauri serves custom schemes as http://<scheme>.localhost on Windows/Android and <scheme>://localhost elsewhere.
function imageProxyUrl(src) {
    if (!isTauriApp() || !src) return '';
    const base = window.location.protocol === 'tauri:' ? 'imgproxy://localhost/' : 'http://imgproxy.localhost/';
    return `${base}?u=${encodeURIComponent(src)}`;
}

function isDoubanImage(src) {
    return /(^https?:)?\/\/[^/]*doubanio\.com\//i.test(src || '');
}

// size: 's' (list) | 'm' (banner / large screens)
function doubanCover(src, size = 's') {
    if (!src) return '';
    return src.replace(/@.*$/, '').replace(/\/[sml]_ratio_poster\//, `/${size}_ratio_poster/`);
}

// Douban rejects requests without a douban.com Referer, so its covers always go through the proxy.
function posterSrc(src, size = 's') {
    if (!src || !/^https?:\/\//i.test(src)) return NO_COVER_IMAGE;
    if (isDoubanImage(src)) return imageProxyUrl(doubanCover(src, size)) || doubanCover(src, size);
    return src;
}

function posterImgHtml(src, alt, extraClass = '', size = 's') {
    const original = src && /^https?:\/\//i.test(src) ? src : '';
    return `<img src="${escapeHtml(posterSrc(original, size))}" alt="${escapeHtml(alt)}" class="${extraClass}"
        data-poster="${escapeHtml(original)}" loading="lazy" decoding="async" referrerpolicy="no-referrer" draggable="false">`;
}

// Fallback chain for posters: direct -> image proxy -> local placeholder.
document.addEventListener('error', (event) => {
    const img = event.target;
    if (!img || img.tagName !== 'IMG' || !('poster' in img.dataset)) return;
    const original = img.dataset.poster;
    const proxied = imageProxyUrl(original);
    if (original && proxied && img.dataset.stage !== 'proxy' && img.src !== proxied) {
        img.dataset.stage = 'proxy';
        img.src = proxied;
        return;
    }
    if (!img.src.endsWith(NO_COVER_IMAGE)) {
        img.dataset.stage = 'placeholder';
        img.src = NO_COVER_IMAGE;
        img.classList.add('poster-missing');
    }
}, true);
