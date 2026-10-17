// 播放器手势：左半屏上下滑调亮度，右半屏上下滑调音量
// ArtPlayer 只有水平滑动调进度，没有亮度能力，这里补一层遮罩实现

const GESTURE_STORAGE_KEY = 'playerGestureEnabled';
const GESTURE_BRIGHTNESS_KEY = 'playerBrightness';
const GESTURE_MIN_BRIGHTNESS = 0.3;
const GESTURE_TRIGGER_PX = 12;

const gestureState = {
    active: false,
    mode: '',          // 'brightness' | 'volume'
    startX: 0,
    startY: 0,
    startValue: 0,
    target: null,
    hud: null,
    brightness: 1,
    overlay: null
};

function isGestureEnabled() {
    return localStorage.getItem(GESTURE_STORAGE_KEY) !== 'false';
}

function setGestureEnabled(enabled) {
    localStorage.setItem(GESTURE_STORAGE_KEY, enabled ? 'true' : 'false');
    if (!enabled) hideGestureHud();
}

function applyBrightnessOverlay(value) {
    if (!gestureState.overlay) {
        const overlay = document.createElement('div');
        overlay.className = 'player-brightness-overlay';
        const container = document.getElementById('player');
        if (!container) return;
        container.appendChild(overlay);
        gestureState.overlay = overlay;
    }
    const clamped = Math.min(1, Math.max(GESTURE_MIN_BRIGHTNESS, value));
    gestureState.brightness = clamped;
    // 亮度用黑色遮罩模拟：值越小遮罩越不透明
    gestureState.overlay.style.opacity = String(1 - clamped);
}

function initBrightness() {
    const saved = parseFloat(localStorage.getItem(GESTURE_BRIGHTNESS_KEY) || '1');
    applyBrightnessOverlay(isNaN(saved) ? 1 : saved);
}

function persistBrightness() {
    localStorage.setItem(GESTURE_BRIGHTNESS_KEY, String(gestureState.brightness));
}

function ensureGestureHud() {
    if (gestureState.hud) return gestureState.hud;
    const hud = document.createElement('div');
    hud.className = 'player-gesture-hud hidden';
    hud.innerHTML = '<span class="player-gesture-label"></span><span class="player-gesture-bar"><i></i></span>';
    const container = document.getElementById('player');
    if (container) container.appendChild(hud);
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

function gestureVolume() {
    return typeof art !== 'undefined' && art && typeof art.volume === 'number' ? art.volume : 1;
}

function setGestureVolume(value) {
    if (typeof art === 'undefined' || !art) return;
    art.volume = Math.min(1, Math.max(0, value));
}

function gestureStartValueFor(mode) {
    return mode === 'brightness' ? gestureState.brightness : gestureVolume();
}

function applyGestureValue(mode, value) {
    if (mode === 'brightness') applyBrightnessOverlay(value);
    else setGestureVolume(value);
    showGestureHud(mode, mode === 'brightness' ? value : gestureVolume());
}

function onGestureStart(event) {
    if (!isGestureEnabled()) return;
    if (event.touches && event.touches.length !== 1) return;
    const touch = event.touches ? event.touches[0] : event;
    const container = document.getElementById('player');
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const x = (touch.clientX || 0) - rect.left;
    gestureState.active = true;
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

    if (!gestureState.mode) {
        // 垂直位移必须明显大于水平位移，才接管手势，否则交还给 ArtPlayer 调进度
        if (Math.abs(dy) < GESTURE_TRIGGER_PX) return;
        if (Math.abs(dy) <= Math.abs(dx)) return;
        gestureState.mode = gestureState.target;
        gestureState.startValue = gestureStartValueFor(gestureState.mode);
    }

    const rect = document.getElementById('player')?.getBoundingClientRect();
    const height = rect && rect.height ? rect.height : window.innerHeight;
    // 整屏高度对应 100% 变化量
    const delta = -dy / height;
    const next = Math.min(1, Math.max(0, gestureState.startValue + delta));
    applyGestureValue(gestureState.mode, next);
    event.preventDefault();
}

function onGestureEnd() {
    if (!gestureState.active) return;
    if (gestureState.mode === 'brightness') persistBrightness();
    gestureState.active = false;
    gestureState.mode = '';
    setTimeout(hideGestureHud, 400);
}

function setupPlayerGestures() {
    const container = document.getElementById('player');
    if (!container) return;
    initBrightness();
    // 只有触屏设备才启用，桌面端保留原有鼠标交互
    if (!isMobileDevice()) return;
    container.addEventListener('touchstart', onGestureStart, { passive: true });
    container.addEventListener('touchmove', onGestureMove, { passive: false });
    container.addEventListener('touchend', onGestureEnd, { passive: true });
    container.addEventListener('touchcancel', onGestureEnd, { passive: true });
}
