// 播放器手势：左半屏上下滑调亮度，右半屏上下滑调音量
// 安卓走原生屏幕亮度与系统媒体音量；其他环境退回 CSS 遮罩与 H5 音量

const GESTURE_STORAGE_KEY = 'playerGestureEnabled';
const GESTURE_BRIGHTNESS_KEY = 'playerBrightness';
const GESTURE_VOLUME_KEY = 'playerVolume';
const GESTURE_MIN_BRIGHTNESS = 0.3;
// 判定阈值：垂直位移超过这个距离且明显大于水平位移，才接管手势
const GESTURE_TRIGGER_PX = 16;
const GESTURE_AXIS_RATIO = 1.2;

const gestureState = {
    active: false,
    decided: false,    // 本次触摸是否已判定方向
    mode: '',          // 'brightness' | 'volume'
    startX: 0,
    startY: 0,
    startValue: 0,
    target: null,
    hud: null,
    brightness: 1,
    overlay: null,
    bound: false
};

function isGestureEnabled() {
    return localStorage.getItem(GESTURE_STORAGE_KEY) !== 'false';
}

function setGestureEnabled(enabled) {
    localStorage.setItem(GESTURE_STORAGE_KEY, enabled ? 'true' : 'false');
    if (!enabled) hideGestureHud();
}

function nativeBridge() {
    const bridge = typeof getAndroidBridge === 'function' ? getAndroidBridge() : null;
    return bridge || null;
}

function applyBrightness(value) {
    const clamped = Math.min(1, Math.max(GESTURE_MIN_BRIGHTNESS, value));
    gestureState.brightness = clamped;
    const bridge = nativeBridge();
    if (bridge && typeof bridge.setBrightness === 'function') {
        try {
            bridge.setBrightness(clamped);
            return;
        } catch (e) { /* 退回遮罩 */ }
    }
    // 无原生能力时用黑色遮罩模拟：值越小遮罩越不透明
    if (!gestureState.overlay) {
        const overlay = document.createElement('div');
        overlay.className = 'player-brightness-overlay';
        const container = document.getElementById('player');
        if (!container) return;
        container.appendChild(overlay);
        gestureState.overlay = overlay;
    }
    gestureState.overlay.style.opacity = String(1 - clamped);
}

// 兼容旧调用名
function applyBrightnessOverlay(value) {
    applyBrightness(value);
}

function initBrightness() {
    const saved = parseFloat(localStorage.getItem(GESTURE_BRIGHTNESS_KEY) || '1');
    applyBrightness(isNaN(saved) ? 1 : saved);
}

function persistBrightness() {
    localStorage.setItem(GESTURE_BRIGHTNESS_KEY, String(gestureState.brightness));
}

function gestureVolume() {
    const bridge = nativeBridge();
    if (bridge && typeof bridge.getVolume === 'function') {
        try {
            const value = bridge.getVolume();
            if (typeof value === 'number' && value >= 0) return value / 100;
        } catch (e) { /* 退回 H5 音量 */ }
    }
    return typeof art !== 'undefined' && art && typeof art.volume === 'number' ? art.volume : 1;
}

function setGestureVolume(value) {
    const clamped = Math.min(1, Math.max(0, value));
    const bridge = nativeBridge();
    if (bridge && typeof bridge.setVolume === 'function') {
        try {
            // 系统媒体音量：0-100
            bridge.setVolume(Math.round(clamped * 100));
            localStorage.setItem(GESTURE_VOLUME_KEY, String(clamped));
            return;
        } catch (e) { /* 退回 H5 音量 */ }
    }
    if (typeof art === 'undefined' || !art) return;
    art.volume = clamped;
    localStorage.setItem(GESTURE_VOLUME_KEY, String(clamped));
}

function gestureStartValueFor(mode) {
    return mode === 'brightness' ? gestureState.brightness : gestureVolume();
}

function applyGestureValue(mode, value) {
    if (mode === 'brightness') applyBrightness(value);
    else setGestureVolume(value);
    const shown = mode === 'brightness' ? gestureState.brightness : gestureVolume();
    showGestureHud(mode, shown);
}

function ensureGestureHud() {
    if (gestureState.hud && gestureState.hud.parentNode) return gestureState.hud;
    const hud = document.createElement('div');
    hud.className = 'player-gesture-hud hidden';
    hud.innerHTML = '<span class="player-gesture-label"></span><span class="player-gesture-bar"><i></i></span>';
    // 全屏时播放器会被移到 body 下，HUD 也挂到 body，保证两种形态都可见
    document.body.appendChild(hud);
    gestureState.hud = hud;
    return hud;
}

function showGestureHud(kind, value) {
    const hud = ensureGestureHud();
    if (!hud) return;
    const isBrightness = kind === 'brightness';
    hud.querySelector('.player-gesture-label').textContent =
        `${isBrightness ? '亮度' : '音量'} ${Math.round(value * 100)}%`;
    hud.querySelector('.player-gesture-bar i').style.width = `${Math.round(value * 100)}%`;
    hud.classList.remove('hidden');
}

function hideGestureHud() {
    if (gestureState.hud) gestureState.hud.classList.add('hidden');
}

// 全屏时 ArtPlayer 会把播放器移出 #player，这里取当前真正可见的播放器容器
function gestureSurface() {
    if (typeof art !== 'undefined' && art && art.template && art.template.$player) return art.template.$player;
    return document.getElementById('player');
}

function onGestureStart(event) {
    if (!isGestureEnabled()) return;
    if (event.touches && event.touches.length !== 1) return;
    const touch = event.touches ? event.touches[0] : event;
    const surface = gestureSurface();
    if (!surface) return;
    const rect = surface.getBoundingClientRect();
    const x = (touch.clientX || 0) - rect.left;
    gestureState.active = true;
    gestureState.decided = false;
    gestureState.mode = '';
    gestureState.startX = touch.clientX || 0;
    gestureState.startY = touch.clientY || 0;
    gestureState.target = x < rect.width / 2 ? 'brightness' : 'volume';
    gestureState.startValue = 0;
}

function onGestureMove(event) {
    if (!gestureState.active || !isGestureEnabled()) return;
    const touch = event.touches ? event.touches[0] : event;
    const dx = (touch.clientX || 0) - gestureState.startX;
    const dy = (touch.clientY || 0) - gestureState.startY;

    if (!gestureState.decided) {
        const absX = Math.abs(dx);
        const absY = Math.abs(dy);
        // 位移还很小时先不判定，避免轻微抖动就抢走手势
        if (absX < GESTURE_TRIGGER_PX && absY < GESTURE_TRIGGER_PX) return;
        gestureState.decided = true;
        // 垂直位移必须明显大于水平位移才接管，否则视为调进度，完全放行给 ArtPlayer
        if (absY > GESTURE_TRIGGER_PX && absY > absX * GESTURE_AXIS_RATIO) {
            gestureState.mode = gestureState.target;
            gestureState.startValue = gestureStartValueFor(gestureState.mode);
        } else {
            gestureState.mode = '';
            return;
        }
    }

    if (!gestureState.mode) return;

    const rect = gestureSurface()?.getBoundingClientRect();
    const height = rect && rect.height ? rect.height : window.innerHeight;
    // 整屏高度对应 100% 变化量
    const delta = -dy / height;
    const next = Math.min(1, Math.max(0, gestureState.startValue + delta));
    applyGestureValue(gestureState.mode, next);
    // 已确认是调亮度/音量，必须阻断，否则 ArtPlayer 会同时调进度
    event.preventDefault();
    event.stopPropagation();
}

function onGestureEnd() {
    if (!gestureState.active) return;
    if (gestureState.mode === 'brightness') persistBrightness();
    if (gestureState.mode === 'volume') {
        localStorage.setItem(GESTURE_VOLUME_KEY, String(gestureVolume()));
    }
    gestureState.active = false;
    gestureState.decided = false;
    gestureState.mode = '';
    setTimeout(hideGestureHud, 400);
}

// 全屏切换会重挂播放器节点，监听绑在 document 上才能覆盖两种形态
function setupPlayerGestures() {
    initBrightness();
    if (!isMobileDevice()) return;
    if (gestureState.bound) return;
    document.addEventListener('touchstart', onGestureStart, { passive: true, capture: true });
    document.addEventListener('touchmove', onGestureMove, { passive: false, capture: true });
    document.addEventListener('touchend', onGestureEnd, { passive: true, capture: true });
    document.addEventListener('touchcancel', onGestureEnd, { passive: true, capture: true });
    gestureState.bound = true;
}
