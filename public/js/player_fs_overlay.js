// 全屏播放时顶部信息条：剧名、集数、分辨率、电量、时钟
// 只在全屏（网页全屏或原生全屏）出现，跟随 ArtPlayer 的 art-control-show 一起淡入淡出，
// 不额外接管点击事件，避免和 ArtPlayer 自己的「点一下显示控制条」打架。

const FS_OVERLAY_CLOCK_MS = 10000;

const fsOverlayState = {
    bound: false,
    root: null,
    titleEl: null,
    metaEl: null,
    batteryEl: null,
    clockEl: null,
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

function ensureFsOverlay() {
    const host = art && art.template && art.template.$player;
    if (!host) return null;
    if (fsOverlayState.root && fsOverlayState.root.isConnected && fsOverlayState.root.parentNode === host) {
        return fsOverlayState.root;
    }
    const root = document.createElement('div');
    root.className = 'player-fs-topbar';
    root.innerHTML = `
        <div class="player-fs-topbar-main">
            <span class="player-fs-topbar-title"></span>
            <span class="player-fs-topbar-meta hidden"></span>
        </div>
        <div class="player-fs-topbar-side">
            <span class="player-fs-topbar-clock"></span>
            <span class="player-fs-topbar-battery hidden"></span>
        </div>`;
    host.appendChild(root);
    fsOverlayState.root = root;
    fsOverlayState.titleEl = root.querySelector('.player-fs-topbar-title');
    fsOverlayState.metaEl = root.querySelector('.player-fs-topbar-meta');
    fsOverlayState.batteryEl = root.querySelector('.player-fs-topbar-battery');
    fsOverlayState.clockEl = root.querySelector('.player-fs-topbar-clock');
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
