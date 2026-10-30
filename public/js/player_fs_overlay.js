// 全屏播放时顶部信息条：剧名、集数、分辨率、电量、时钟
// 只在全屏（网页全屏或原生全屏）出现，跟随 ArtPlayer 的 art-control-show 一起淡入淡出，
// 不额外接管点击事件，避免和 ArtPlayer 自己的「点一下显示控制条」打架。

const FS_OVERLAY_CLOCK_MS = 10000;

// 返回箭头：全屏时顶部条是唯一稳定的返回入口（车机没有系统返回栏，网页全屏也没有）
const FS_BACK_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">'
    + '<path d="M15.5 4.5 8 12l7.5 7.5" fill="none" stroke="currentColor" '
    + 'stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// 下载和片头标记原本挂在播放器控制条上，手机上会把「全屏」按钮挤出屏幕，
// 全屏时又摸不到下面的按钮，所以统一挪到顶部条右上角
const FS_DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">'
    + '<path d="M12 3a1 1 0 0 1 1 1v8.6l2.3-2.3a1 1 0 0 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.4L11 12.6V4a1 1 0 0 1 1-1z"/>'
    + '<path d="M5 18a1 1 0 0 1 1 1h12a1 1 0 0 1 1-1v1a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-1z"/></svg>';

const FS_INTRO_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">'
    + '<path d="M6 3.5a1 1 0 0 1 1 1v15a1 1 0 0 1-2 0v-15a1 1 0 0 1 1-1z"/>'
    + '<path d="M9 4.6a1 1 0 0 1 1.5-.87l8 5.4a1 1 0 0 1 0 1.74l-8 5.4A1 1 0 0 1 9 15.4V4.6z"/></svg>';

const fsOverlayState = {
    bound: false,
    root: null,
    backEl: null,
    titleEl: null,
    metaEl: null,
    batteryEl: null,
    clockEl: null,
    downloadEl: null,
    introEl: null,
    clockTimer: null,
    batteryManager: null
};

function fsEpisodeLabel() {
    if (typeof getEpisodeLabel !== 'function') return '';
    if (!Array.isArray(currentEpisodes) || currentEpisodes.length <= 1) return '';
    const label = getEpisodeLabel(currentEpisodeIndex);
    return label ? `${label} · 共 ${currentEpisodes.length} 集` : '';
}

function fsResolutionLabel() {
    const badge = document.getElementById('playerResolutionBadge');
    const text = badge ? (badge.textContent || '').trim() : '';
    return text;
}

function fsClockText() {
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}

// 点返回箭头退出全屏。原生全屏和网页全屏都要处理，两者在车机上可能同时存在。
function exitFullscreenFromOverlay(event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    if (typeof document !== 'undefined' && document.fullscreenElement && document.exitFullscreen) {
        try {
            document.exitFullscreen();
            return;
        } catch (e) { /* 落到下面按 ArtPlayer 的状态退 */ }
    }
    if (typeof art === 'undefined' || !art) return;
    if (art.fullscreenWeb) {
        art.fullscreenWeb = false;
        return;
    }
    if (art.fullscreen) art.fullscreen = false;
}

function updateFsOverlay() {
    if (!fsOverlayState.root) return;
    if (fsOverlayState.titleEl) fsOverlayState.titleEl.textContent = currentVideoTitle || '正在播放';
    if (fsOverlayState.metaEl) {
        const parts = [fsEpisodeLabel(), fsResolutionLabel()].filter(Boolean);
        fsOverlayState.metaEl.textContent = parts.join(' · ');
        fsOverlayState.metaEl.classList.toggle('hidden', !parts.length);
    }
    if (fsOverlayState.clockEl) fsOverlayState.clockEl.textContent = fsClockText();
}

function renderBattery(level, charging) {
    const el = fsOverlayState.batteryEl;
    if (!el) return;
    if (typeof level !== 'number' || isNaN(level)) {
        el.classList.add('hidden');
        return;
    }
    const percent = Math.round(level * 100);
    el.classList.remove('hidden');
    el.classList.toggle('charging', !!charging);
    el.textContent = `${percent}%`;
}

// 电量 API 在老 WebView 里可能不存在，拿不到就整块隐藏，不留空占位
function setupBatteryWatch() {
    if (!navigator.getBattery) {
        renderBattery(NaN, false);
        return;
    }
    navigator.getBattery().then(battery => {
        fsOverlayState.batteryManager = battery;
        const refresh = () => renderBattery(battery.level, battery.charging);
        refresh();
        battery.addEventListener('levelchange', refresh);
        battery.addEventListener('chargingchange', refresh);
    }).catch(() => renderBattery(NaN, false));
}

// 顶部条上的动作按钮：下载本集、以当前位置为片头结束。
// 这两个动作原本在播放器控制条里，手机上挤掉「全屏」按钮，所以搬到这里。
function runFsOverlayAction(name, event) {
    if (event) {
        event.preventDefault();
        event.stopPropagation();
    }
    if (name === 'download') {
        if (typeof requestEpisodeDownload === 'function') requestEpisodeDownload();
        return;
    }
    if (name === 'intro' && typeof markIntroEndHere === 'function') markIntroEndHere();
}

function bindFsOverlayAction(el, name) {
    if (!el) return;
    const handler = event => runFsOverlayAction(name, event);
    el.addEventListener('click', handler);
    // 车机上 touchstart 比 click 可靠，preventDefault 之后浏览器不会再补发 click
    el.addEventListener('touchstart', handler, { passive: false });
}

function ensureFsOverlay() {
    const host = art && art.template && art.template.$player;
    if (!host) return null;
    if (fsOverlayState.root && fsOverlayState.root.isConnected && fsOverlayState.root.parentNode === host) {
        return fsOverlayState.root;
    }
    const root = document.createElement('div');
    root.className = 'player-fs-topbar';
    root.innerHTML = `
        <button type="button" class="player-fs-topbar-back" aria-label="退出全屏">${FS_BACK_ICON}</button>
        <div class="player-fs-topbar-main">
            <span class="player-fs-topbar-title"></span>
            <span class="player-fs-topbar-meta hidden"></span>
        </div>
        <div class="player-fs-topbar-side">
            <button type="button" class="player-fs-topbar-action" data-fs-action="download" aria-label="下载本集" title="下载本集">${FS_DOWNLOAD_ICON}</button>
            <button type="button" class="player-fs-topbar-action" data-fs-action="intro" aria-label="以当前位置为片头结束" title="以当前位置为片头结束">${FS_INTRO_ICON}</button>
            <span class="player-fs-topbar-clock"></span>
            <span class="player-fs-topbar-battery hidden"></span>
        </div>`;
    host.appendChild(root);
    fsOverlayState.root = root;
    fsOverlayState.backEl = root.querySelector('.player-fs-topbar-back');
    fsOverlayState.titleEl = root.querySelector('.player-fs-topbar-title');
    fsOverlayState.metaEl = root.querySelector('.player-fs-topbar-meta');
    fsOverlayState.batteryEl = root.querySelector('.player-fs-topbar-battery');
    fsOverlayState.clockEl = root.querySelector('.player-fs-topbar-clock');
    fsOverlayState.downloadEl = root.querySelector('[data-fs-action="download"]');
    fsOverlayState.introEl = root.querySelector('[data-fs-action="intro"]');
    if (fsOverlayState.backEl) {
        fsOverlayState.backEl.addEventListener('click', exitFullscreenFromOverlay);
        // 车机上 touchstart 比 click 可靠，preventDefault 之后浏览器不会再补发 click
        fsOverlayState.backEl.addEventListener('touchstart', exitFullscreenFromOverlay, { passive: false });
    }
    bindFsOverlayAction(fsOverlayState.downloadEl, 'download');
    bindFsOverlayAction(fsOverlayState.introEl, 'intro');
    // 没有下载模块时（比如播放页没加载 player_download.js）不留一个点不动的按钮
    if (fsOverlayState.downloadEl && typeof requestEpisodeDownload !== 'function') {
        fsOverlayState.downloadEl.classList.add('hidden');
    }
    return root;
}

function setupFullscreenOverlay(instance) {
    if (!instance || fsOverlayState.bound) return;
    fsOverlayState.bound = true;

    ensureFsOverlay();
    updateFsOverlay();
    setupBatteryWatch();

    // 时钟每分钟看一眼即可，用 10 秒轮询保证跨分钟时不会显示旧值
    clearInterval(fsOverlayState.clockTimer);
    fsOverlayState.clockTimer = setInterval(updateFsOverlay, FS_OVERLAY_CLOCK_MS);

    // 分辨率角标由 MANIFEST_PARSED / LEVEL_SWITCHED 更新，这里跟着刷新顶部条
    instance.on('video:loadedmetadata', updateFsOverlay);
    instance.on('fullscreenWeb', () => {
        // 全屏时播放器会被移进 body，节点重建后顶部条要重新挂
        setTimeout(() => { ensureFsOverlay(); updateFsOverlay(); }, 0);
    });
    instance.on('fullscreen', () => {
        setTimeout(() => { ensureFsOverlay(); updateFsOverlay(); }, 0);
    });
}

function teardownFullscreenOverlay() {
    clearInterval(fsOverlayState.clockTimer);
    fsOverlayState.clockTimer = null;
    if (fsOverlayState.root && fsOverlayState.root.parentNode) {
        fsOverlayState.root.parentNode.removeChild(fsOverlayState.root);
    }
    fsOverlayState.root = null;
    fsOverlayState.bound = false;
}
