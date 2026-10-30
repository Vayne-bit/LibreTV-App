/* 播放器高度兜底：Chrome 88 之前没有 aspect-ratio。
   .player-shell 只有宽度没有高度，而里面的 .player-box / .art-video-player 都是
   height: 100%，父元素高度是 auto 时百分比失效，最后一层全是绝对定位元素，
   整块高度塌成 0 —— 表现就是有声音没画面、控制条也点不到。
   这里只在不支持 aspect-ratio 的浏览器上补一个明确高度；支持的浏览器直接返回，
   行为和现在完全一致。 */

const PLAYER_LAYOUT_ASPECT = 16 / 9;
const PLAYER_LAYOUT_MIN_HEIGHT = 120;
const PLAYER_LAYOUT_DESKTOP_RESERVED = 180;
const PLAYER_LAYOUT_MOBILE_RESERVED = 48;
const PLAYER_LAYOUT_DESKTOP_QUERY = '(min-width: 960px) and (min-height: 560px)';
const PLAYER_LAYOUT_RETRY_MS = 100;
const PLAYER_LAYOUT_RETRY_MAX = 30;

let playerLayoutState = {
    shell: null,
    frame: 0,
    retryTimer: 0,
    retryCount: 0,
    bound: false
};

// CSS.supports 不存在或抛错时按「支持」处理：宁可不动，也不能误改正常设备的布局
function playerLayoutSupportsAspectRatio() {
    try {
        if (typeof CSS === 'undefined' || !CSS || typeof CSS.supports !== 'function') return true;
        return !!(CSS.supports('aspect-ratio', '16 / 9') || CSS.supports('aspect-ratio: 16 / 9'));
    } catch (e) {
        return true;
    }
}

function playerLayoutSafeTop() {
    try {
        const value = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-top'));
        return Number.isFinite(value) ? value : 0;
    } catch (e) {
        return 0;
    }
}

function playerLayoutViewportHeight() {
    const visual = window.visualViewport;
    if (visual && Number.isFinite(visual.height) && visual.height > 0) return visual.height;
    if (Number.isFinite(window.innerHeight) && window.innerHeight > 0) return window.innerHeight;
    const client = document.documentElement && document.documentElement.clientHeight;
    return Number.isFinite(client) ? client : 0;
}

function playerLayoutIsDesktop() {
    try {
        if (!window.matchMedia) return false;
        return !!window.matchMedia(PLAYER_LAYOUT_DESKTOP_QUERY).matches;
    } catch (e) {
        return false;
    }
}

// 宽度决定理想高度，可用高度决定上限；两者取小，再留一个下限防止极端窄高时归零
function playerLayoutComputeHeight(width) {
    if (!width || width <= 0) return 0;
    const reserved = playerLayoutIsDesktop()
        ? PLAYER_LAYOUT_DESKTOP_RESERVED
        : PLAYER_LAYOUT_MOBILE_RESERVED + playerLayoutSafeTop();
    const available = playerLayoutViewportHeight() - reserved;
    const ideal = width / PLAYER_LAYOUT_ASPECT;
    return Math.max(PLAYER_LAYOUT_MIN_HEIGHT, Math.min(ideal, available));
}

function playerLayoutShellWidth(shell) {
    try {
        const rect = shell.getBoundingClientRect();
        if (rect && rect.width > 0) return rect.width;
    } catch (e) {
        /* 拿不到布局信息就退回 clientWidth */
    }
    return shell.clientWidth || 0;
}

function applyPlayerLayoutHeight() {
    const shell = playerLayoutState.shell || document.querySelector('.player-shell');
    if (!shell) return false;
    playerLayoutState.shell = shell;
    const height = playerLayoutComputeHeight(playerLayoutShellWidth(shell));
    // 宽度还是 0（样式表没加载完），交给重试
    if (!height) return false;
    shell.style.height = `${Math.round(height)}px`;
    return true;
}

function stopPlayerLayoutRetry() {
    if (!playerLayoutState.retryTimer) return;
    clearInterval(playerLayoutState.retryTimer);
    playerLayoutState.retryTimer = 0;
    playerLayoutState.retryCount = 0;
}

function startPlayerLayoutRetry() {
    if (playerLayoutState.retryTimer) return;
    if (playerLayoutState.retryCount >= PLAYER_LAYOUT_RETRY_MAX) return;
    playerLayoutState.retryTimer = setInterval(() => {
        playerLayoutState.retryCount += 1;
        if (applyPlayerLayoutHeight() || playerLayoutState.retryCount >= PLAYER_LAYOUT_RETRY_MAX) {
            stopPlayerLayoutRetry();
        }
    }, PLAYER_LAYOUT_RETRY_MS);
}

function schedulePlayerLayout() {
    if (playerLayoutState.frame) return;
    const run = () => {
        playerLayoutState.frame = 0;
        playerLayoutState.retryCount = 0;
        if (!applyPlayerLayoutHeight()) startPlayerLayoutRetry();
    };
    if (typeof requestAnimationFrame === 'function') {
        playerLayoutState.frame = requestAnimationFrame(run);
    } else {
        playerLayoutState.frame = setTimeout(run, 16);
    }
}

function setupPlayerLayout() {
    // 新内核走 CSS 的 aspect-ratio，一行都不碰
    if (playerLayoutSupportsAspectRatio()) return false;
    const shell = document.querySelector('.player-shell');
    if (!shell) return false;
    playerLayoutState.shell = shell;
    playerLayoutState.retryCount = 0;
    applyPlayerLayoutHeight();
    startPlayerLayoutRetry();
    if (!playerLayoutState.bound) {
        playerLayoutState.bound = true;
        window.addEventListener('resize', schedulePlayerLayout);
        window.addEventListener('orientationchange', schedulePlayerLayout);
        const visual = window.visualViewport;
        if (visual && typeof visual.addEventListener === 'function') {
            visual.addEventListener('resize', schedulePlayerLayout);
            visual.addEventListener('scroll', schedulePlayerLayout);
        }
    }
    return true;
}

if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    document.addEventListener('DOMContentLoaded', () => {
        try {
            setupPlayerLayout();
        } catch (e) {
            console.warn('player layout setup failed', e);
        }
    });
}
