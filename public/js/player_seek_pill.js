// 拖动进度条时在画面正中间显示目标时间。
// ArtPlayer 自带的 .art-progress-tip 贴在进度条上，手指一按就被盖住了，
// 车机屏幕大、手指也大，所以额外在中间再显示一份。
//
// 只在用户真的按在进度条上时才显示：续播跳转、跳过片头这类程序自己的 seek 不弹。

const SEEK_PILL_HIDE_MS = 600;

const seekPillState = {
    art: null,
    el: null,
    timeEl: null,
    totalEl: null,
    hideTimer: null,
    dragging: false,
    bound: false
};

function seekPillFormat(seconds) {
    if (typeof formatTime === 'function') return formatTime(Math.max(0, seconds || 0));
    const total = Math.max(0, Math.floor(seconds || 0));
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function ensureSeekPill(art) {
    if (!art || !art.video) return null;
    const host = art.video.parentElement;
    if (!host) return null;
    if (seekPillState.el && seekPillState.el.parentElement === host) return seekPillState.el;
    if (seekPillState.el && seekPillState.el.parentElement) seekPillState.el.parentElement.removeChild(seekPillState.el);
    const el = document.createElement('div');
    el.className = 'player-seek-pill';
    el.innerHTML = '<span class="player-seek-pill-time">00:00</span><span class="player-seek-pill-total">/ 00:00</span>';
    host.appendChild(el);
    seekPillState.el = el;
    seekPillState.timeEl = el.querySelector('.player-seek-pill-time');
    seekPillState.totalEl = el.querySelector('.player-seek-pill-total');
    return el;
}

function showSeekPill() {
    const art = seekPillState.art;
    if (!art || !art.video) return;
    const el = ensureSeekPill(art);
    if (!el) return;
    clearTimeout(seekPillState.hideTimer);
    seekPillState.hideTimer = null;
    if (seekPillState.timeEl) seekPillState.timeEl.textContent = seekPillFormat(art.video.currentTime);
    if (seekPillState.totalEl) seekPillState.totalEl.textContent = `/ ${seekPillFormat(art.video.duration)}`;
    el.classList.add('show');
}

function hideSeekPill() {
    clearTimeout(seekPillState.hideTimer);
    seekPillState.hideTimer = null;
    if (seekPillState.el) seekPillState.el.classList.remove('show');
}

function scheduleSeekPillHide() {
    clearTimeout(seekPillState.hideTimer);
    seekPillState.hideTimer = setTimeout(hideSeekPill, SEEK_PILL_HIDE_MS);
}

function seekPillPointerDown(event) {
    const target = event.target;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest('.art-progress')) return;
    seekPillState.dragging = true;
    showSeekPill();
}

function seekPillPointerUp() {
    if (!seekPillState.dragging) return;
    seekPillState.dragging = false;
    scheduleSeekPillHide();
}

function setupSeekPill(art) {
    if (!art || !art.video) return;
    seekPillState.art = art;
    ensureSeekPill(art);
    if (seekPillState.bound) return;
    seekPillState.bound = true;
    document.addEventListener('pointerdown', seekPillPointerDown, true);
    document.addEventListener('pointerup', seekPillPointerUp, true);
    document.addEventListener('pointercancel', seekPillPointerUp, true);
    art.on('video:seeking', () => {
        if (seekPillState.dragging) showSeekPill();
    });
    art.on('video:timeupdate', () => {
        if (seekPillState.dragging) showSeekPill();
    });
    art.on('video:seeked', () => {
        if (seekPillState.dragging) scheduleSeekPillHide();
    });
    art.on('video:playing', () => {
        seekPillState.dragging = false;
        hideSeekPill();
    });
}

function teardownSeekPill() {
    if (seekPillState.bound) {
        document.removeEventListener('pointerdown', seekPillPointerDown, true);
        document.removeEventListener('pointerup', seekPillPointerUp, true);
        document.removeEventListener('pointercancel', seekPillPointerUp, true);
        seekPillState.bound = false;
    }
    hideSeekPill();
    seekPillState.dragging = false;
    seekPillState.art = null;
}
