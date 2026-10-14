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
