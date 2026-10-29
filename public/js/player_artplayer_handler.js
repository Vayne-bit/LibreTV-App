// ArtPlayer Handler Logic

const PLAYER_ICONS = {
    next: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 6.5v11a1 1 0 0 0 1.52.85l8.5-5.5a1 1 0 0 0 0-1.7l-8.5-5.5A1 1 0 0 0 6 6.5zM17 6h2v12h-2z"/></svg>',
    fullscreenOn: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM6 15v3h3v2H4v-5h2zm12 0h2v5h-5v-2h3v-3z"/></svg>',
    fullscreenOff: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M7 4h2v5H4V7h3V4zm8 0h2v3h3v2h-5V4zM4 15h5v5H7v-3H4v-2zm11 0h5v2h-3v3h-2v-5z"/></svg>',
    download: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M12 3a1 1 0 0 1 1 1v8.6l2.3-2.3a1 1 0 0 1 1.4 1.4l-4 4a1 1 0 0 1-1.4 0l-4-4a1 1 0 0 1 1.4-1.4L11 12.6V4a1 1 0 0 1 1-1zM5 18a1 1 0 0 1 1 1h12a1 1 0 0 1 1-1v1a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-1z"/></svg>',
    introMark: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 3.5a1 1 0 0 1 1 1v15a1 1 0 0 1-2 0v-15a1 1 0 0 1 1-1zM9 4.6a1 1 0 0 1 1.5-.87l8 5.4a1 1 0 0 1 0 1.74l-8 5.4A1 1 0 0 1 9 15.4V4.6z"/></svg>'
};

const HLS_BASE_CONFIG = {
    debug: false,
    enableWorker: true, lowLatencyMode: false,
    // maxBufferHole 是「小于这个值的空洞当作不存在」的阈值。hls.js 1.6.2 默认 0.1，
    // 之前设成 0.5 会让 0.1~0.5s 的真实空洞被忽略，既不去补也不触发 nudge，播到那里就停住。
    maxBufferHole: 0.1, fragLoadingMaxRetry: 6, fragLoadingMaxRetryTimeout: 64000,
    fragLoadingRetryDelay: 1000, manifestLoadingMaxRetry: 3, manifestLoadingRetryDelay: 1000,
    levelLoadingMaxRetry: 4, levelLoadingRetryDelay: 1000, startLevel: -1,
    abrEwmaDefaultEstimate: 500000, abrBandWidthFactor: 0.95, abrBandWidthUpFactor: 0.6,
    // 手机/平板屏上 1080P 和 720P 肉眼几乎没差别，码率却差一倍多，按播放器尺寸封顶最划算
    capLevelToPlayerSize: true, capLevelOnFPSDrop: true,
    abrMaxWithRealBitrate: true, stretchShortVideoTrack: true, appendErrorMaxRetry: 5,
    liveSyncDurationCount: 3, liveDurationInfinity: false
};

function isMobileDevice() {
    return !!getAndroidBridge() || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

// Phones switch cells and lose signal, so they get a deeper buffer; desktops keep the leaner setting.
// 缓冲目标不能设太大：hls.js 的 ABR 用「距离下次卡顿还有多久」判断能不能升档，
// 目标缓冲越长它越敢选高档，结果选到刚好撑不住的码率，播放中反复被抽干。
const HLS_CONFIG = isMobileDevice()
    ? { ...HLS_BASE_CONFIG, backBufferLength: 30, maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 60 * 1000 * 1000 }
    : { ...HLS_BASE_CONFIG, backBufferLength: 90, maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 30 * 1000 * 1000 };

const BUFFER_LEVEL_STORAGE_KEY = 'playerBufferLevel';
// 上面那条「缓冲越大越敢升档」只对多码率源成立。采集站常见 1080p 只有一路 2000kbps，
// 没有档可降，缓冲越大越能扛住网速抖动，所以单档源反而要加深缓冲。
const BUFFER_PRESETS = {
    low: { maxBufferLength: 15, maxMaxBufferLength: 30, maxBufferSize: 30 * 1000 * 1000 },
    normal: { maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 60 * 1000 * 1000 },
    deep: { maxBufferLength: 60, maxMaxBufferLength: 120, maxBufferSize: 120 * 1000 * 1000 }
};

function readBufferLevel() {
    const saved = localStorage.getItem(BUFFER_LEVEL_STORAGE_KEY);
    return saved === 'low' || saved === 'high' ? saved : 'auto';
}

function bufferPresetFor(level, variantCount) {
    if (level === 'low') return BUFFER_PRESETS.low;
    if (level === 'high') return BUFFER_PRESETS.deep;
    return variantCount === 1 ? BUFFER_PRESETS.deep : BUFFER_PRESETS.normal;
}

// hls.config 就是各个 controller 持有的那个对象，改字段立刻生效
function applyBufferPreset(hls, preset) {
    if (!hls || !hls.config || !preset) return;
    hls.config.maxBufferLength = preset.maxBufferLength;
    hls.config.maxMaxBufferLength = preset.maxMaxBufferLength;
    hls.config.maxBufferSize = preset.maxBufferSize;
}

let playbackStarted = false;
let pendingSeekPosition = 0;
let slowLoadTimer = null;
let screenWakeLock = null;

function getVideoType(url) {
    const path = String(url || '').split('?')[0].toLowerCase();
    if (path.endsWith('.flv')) return 'flv';
    if (/\.(mp4|webm|mkv|mov|m4v)$/.test(path)) return path.split('.').pop();
    return 'm3u8';
}

function destroyStreamEngines(instance) {
    if (!instance) return;
    if (instance.hls) { try { instance.hls.destroy(); } catch (e) { /* ignore */ } instance.hls = null; }
    if (instance.flv) { try { instance.flv.destroy(); } catch (e) { /* ignore */ } instance.flv = null; }
    // 旧的 hls 实例已经销毁，缓存层不能再从它身上读带宽估计
    if (typeof bindSegmentCacheHls === 'function') bindSegmentCacheHls(null);
}

// 片源加载失败：先尝试自动换源，找不到再显示错误页
function handleSourceFailure() {
    if (typeof autoRelinkAndPlay === 'function') {
        autoRelinkAndPlay().then(result => {
            if (!result || !result.ok) {
                showPlayerError('视频加载失败，可能是线路失效或格式不兼容');
            }
        }).catch(() => {
            showPlayerError('视频加载失败，可能是线路失效或格式不兼容');
        });
        return;
    }
    showPlayerError('视频加载失败，可能是线路失效或格式不兼容');
}

function playM3u8(video, url, instance) {
    destroyStreamEngines(instance);
    if (!window.Hls || !Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; return; }
        showPlayerError('当前环境不支持播放 m3u8 视频');
        return;
    }
    const bufferLevel = readBufferLevel();
    const hls = new Hls({
        ...HLS_CONFIG,
        ...bufferPresetFor(bufferLevel, 0),
        // 始终用自定义 loader：分片缓存要靠它接管分片请求，关掉广告过滤只是跳过 playlist 处理
        loader: CustomHlsJsLoader
    });
    // 缓存命中时要按当前带宽估算「这些字节真下要多久」，否则 hls.js 会以为网速暴涨而乱升码率
    if (typeof bindSegmentCacheHls === 'function') bindSegmentCacheHls(hls);
    let fatalRecoverCount = 0;
    let bufferAppendErrorCount = 0;
    // 多码率源只有解析完 master playlist 才知道有哪些清晰度，这里同步给角标
    hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        const levels = (data && data.levels) || [];
        const best = levels.reduce((acc, level) => (level && level.height > (acc ? acc.height : 0) ? level : acc), null);
        if (best && best.height) updateResolutionBadge(formatResolution(best.width, best.height));
        // 「自动」档要等知道有几档才能定：单档源加深缓冲，多档源保持浅缓冲让 ABR 敢升档
        if (bufferLevel === 'auto') applyBufferPreset(hls, bufferPresetFor(bufferLevel, levels.length));
    });
    hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
        const levels = (hls.levels || []);
        const level = levels[data && typeof data.level === 'number' ? data.level : hls.currentLevel];
        if (level && level.height) updateResolutionBadge(formatResolution(level.width, level.height));
    });
    hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.details === 'bufferAppendError') {
            bufferAppendErrorCount++;
            if (!playbackStarted && bufferAppendErrorCount >= 3) hls.recoverMediaError();
            return;
        }
        if (!data.fatal) return;
        fatalRecoverCount++;
        if (fatalRecoverCount > 3) {
            if (!playbackStarted) handleSourceFailure();
            return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else if (!playbackStarted) handleSourceFailure();
    });
    hls.loadSource(url);
    hls.attachMedia(video);
    instance.hls = hls;
}

function playFlv(video, url, instance) {
    destroyStreamEngines(instance);
    if (!window.mpegts || !mpegts.isSupported()) {
        showPlayerError('当前环境不支持播放 flv 视频');
        return;
    }
    const flv = mpegts.createPlayer({ type: 'flv', url, isLive: false }, { enableWorker: false, lazyLoad: false });
    flv.attachMediaElement(video);
    flv.load();
    instance.flv = flv;
}

function requestEpisodeDownload() {
    if (typeof toggleEpisodeDownload !== 'function') return;
    const result = toggleEpisodeDownload(currentEpisodeIndex);
    const message = (result && (result.message || result.reason)) || '无法下载这一集';
    if (art && art.notice) art.notice.show = message;
    if (typeof updateEpisodeDownloadBadges === 'function') updateEpisodeDownloadBadges();
}

function buildPlayerSettings() {
    const savedFit = localStorage.getItem('playerObjectFit') || 'contain';
    const gestureEnabled = isGestureEnabled();
    const savedBufferLevel = readBufferLevel();
    const savedIntroSkip = readIntroSkip(currentVideoTitle);
    const items = [{
        html: '画面模式',
        width: 200,
        tooltip: { contain: '适应', cover: '裁剪填满', fill: '拉伸' }[savedFit],
        selector: [
            { html: '适应', value: 'contain', default: savedFit === 'contain' },
            { html: '裁剪填满', value: 'cover', default: savedFit === 'cover' },
            { html: '拉伸', value: 'fill', default: savedFit === 'fill' }
        ],
        onSelect(item) {
            art.video.style.objectFit = item.value;
            localStorage.setItem('playerObjectFit', item.value);
            return item.html;
        }
    }, {
        html: '手势调节',
        tooltip: gestureEnabled ? '开' : '关',
        switch: gestureEnabled,
        onSwitch(item) {
            const enabled = !!item.switch;
            setGestureEnabled(enabled);
            return enabled ? '开' : '关';
        }
    }, {
        html: '缓冲深度',
        width: 200,
        tooltip: { auto: '自动', low: '浅', high: '深' }[savedBufferLevel],
        selector: [
            { html: '自动', value: 'auto', default: savedBufferLevel === 'auto' },
            { html: '浅（起播快）', value: 'low', default: savedBufferLevel === 'low' },
            { html: '深（抗卡顿）', value: 'high', default: savedBufferLevel === 'high' }
        ],
        onSelect(item) {
            localStorage.setItem(BUFFER_LEVEL_STORAGE_KEY, item.value);
            // 立即生效，不用等下一集：当前实例的缓冲目标直接改
            if (art && art.hls) {
                const count = Array.isArray(art.hls.levels) ? art.hls.levels.length : 0;
                applyBufferPreset(art.hls, bufferPresetFor(item.value, count));
            }
            return item.html;
        }
    }, {
        name: 'intro-skip',
        html: '跳过片头',
        width: 200,
        tooltip: introSkipLabel(savedIntroSkip),
        selector: INTRO_SKIP_OPTIONS.map(seconds => ({
            html: introSkipLabel(seconds),
            value: String(seconds),
            default: seconds === savedIntroSkip
        })),
        onSelect(item) {
            const seconds = Number(item.value) || 0;
            writeIntroSkip(currentVideoTitle, seconds);
            // 已经播过片头就不往回跳；还在片头里就立刻跳过去
            if (seconds > 0 && art && art.video && art.video.currentTime < seconds) {
                art.currentTime = seconds;
                art.notice.show = `已跳过片头 ${formatTime(seconds)}`;
            }
            return introSkipLabel(seconds);
        }
    }];
    // ArtPlayer 给设置项定义了 tooltip 的 setter，控制条上标记之后能实时改这里的显示
    introSkipSettingItem = items.find(item => item.name === 'intro-skip') || null;
    return items;
}

// 指向「跳过片头」设置项，控制条上标记片头之后同步更新它的显示值
let introSkipSettingItem = null;

// 片头长度按剧名记，同一部剧各集共用一个值；换一部剧就是各自独立的
const INTRO_SKIP_STORAGE_KEY = 'introSkipMap';
const INTRO_SKIP_OPTIONS = [0, 30, 60, 90, 120, 180, 300];

function readIntroSkipMap() {
    try {
        const raw = localStorage.getItem(INTRO_SKIP_STORAGE_KEY);
        const map = raw ? JSON.parse(raw) : null;
        return map && typeof map === 'object' ? map : {};
    } catch (e) {
        return {};
    }
}

function readIntroSkip(title) {
    if (!title) return 0;
    const seconds = Number(readIntroSkipMap()[title]);
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
}

function writeIntroSkip(title, seconds) {
    if (!title) return;
    const map = readIntroSkipMap();
    if (seconds > 0) map[title] = seconds;
    else delete map[title];
    try {
        localStorage.setItem(INTRO_SKIP_STORAGE_KEY, JSON.stringify(map));
    } catch (e) {
        // 存储写不进去就算了，下次再设一次
    }
}

function introSkipLabel(seconds) {
    if (!seconds) return '关';
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = seconds / 60;
    return Number.isInteger(minutes) ? `${minutes} 分钟` : `${seconds} 秒`;
}

// 控制条上的「以当前位置为片头结束」：播到片头结束那一刻点一下，就把这个秒数记给当前这部剧
function markIntroEndHere() {
    if (!art || !art.video) return;
    if (!currentVideoTitle) {
        if (art.notice) art.notice.show = '还不知道这是哪部剧，先播一会儿再试';
        return;
    }
    const seconds = Math.floor(art.video.currentTime || 0);
    if (seconds < 10) {
        if (art.notice) art.notice.show = '当前位置太靠前，拖到片头结束的地方再点';
        return;
    }
    const duration = art.video.duration || 0;
    if (duration > 0 && seconds > duration - 30) {
        if (art.notice) art.notice.show = '已经接近结尾了，这里不像片头结束的位置';
        return;
    }
    writeIntroSkip(currentVideoTitle, seconds);
    if (introSkipSettingItem) {
        try {
            introSkipSettingItem.tooltip = introSkipLabel(seconds);
        } catch (e) {
            // 设置面板还没渲染出来，下次打开会读到新值
        }
    }
    if (art.notice) art.notice.show = `已记住：片头到 ${formatTime(seconds)}，下次自动跳过`;
}

// 画质菜单由官方 hls-control 插件提供，依赖 art.hls 实例，非 m3u8 源不注册
function buildHlsControlPlugin() {
    if (typeof artplayerPluginHlsControl !== 'function') return null;
    return artplayerPluginHlsControl({
        quality: { title: '清晰度', auto: '自动', control: true, setting: true }
    });
}

function initPlayer(videoUrl) {
    if (!videoUrl) return;
    const androidBridge = getAndroidBridge();
    playbackStarted = false;
    hidePlayerError();

    Artplayer.PLAYBACK_RATE = [0.5, 0.75, 1, 1.25, 1.5, 2, 3];

    art = new Artplayer({
        container: '#player',
        url: videoUrl,
        type: getVideoType(videoUrl),
        customType: { m3u8: playM3u8, flv: playFlv },
        lang: 'zh-cn',
        theme: '#fb7299',
        volume: 0.8,
        autoplay: true,
        autoSize: false,
        autoMini: false,
        playsInline: true,
        mutex: true,
        hotkey: true,
        pip: !androidBridge,
        setting: true,
        playbackRate: true,
        aspectRatio: true,
        flip: true,
        miniProgressBar: true,
        fullscreen: !androidBridge,
        fullscreenWeb: true,
        fastForward: true,
        lock: true,
        gesture: true,
        autoOrientation: !androidBridge,
        backdrop: true,
        airplay: false,
        settings: buildPlayerSettings(),
        plugins: [buildHlsControlPlugin()].filter(Boolean),
        icons: androidBridge ? { fullscreenWebOn: PLAYER_ICONS.fullscreenOn, fullscreenWebOff: PLAYER_ICONS.fullscreenOff } : {},
        controls: [{
            name: 'next-episode',
            position: 'left',
            index: 15,
            html: PLAYER_ICONS.next,
            tooltip: '下一集',
            click: () => playNextEpisode()
        }, {
            name: 'download-episode',
            position: 'left',
            index: 16,
            html: PLAYER_ICONS.download,
            tooltip: '下载本集',
            click: () => requestEpisodeDownload()
        }, {
            name: 'intro-mark',
            position: 'left',
            index: 17,
            html: PLAYER_ICONS.introMark,
            tooltip: '以当前位置为片头结束',
            click: () => markIntroEndHere()
        }],
        moreVideoAttr: { preload: 'auto', 'x5-video-player-type': 'h5' }
    });

    art.on('ready', () => {
        art.video.style.objectFit = localStorage.getItem('playerObjectFit') || 'contain';
        updateNextEpisodeControl();
        // ArtPlayer 会重建容器内容，遮罩和手势要在 ready 之后再挂
        if (typeof setupPlayerGestures === 'function') setupPlayerGestures();
        if (typeof setupPlayerBuffer === 'function') setupPlayerBuffer(art);
        if (typeof setupFullscreenOverlay === 'function') setupFullscreenOverlay(art);
        if (typeof setupSeekPill === 'function') setupSeekPill(art);
    });

    art.on('video:loadedmetadata', () => {
        videoHasEnded = false;
        const duration = art.video.duration || 0;
        const target = pendingSeekPosition;
        pendingSeekPosition = 0;
        if (target > 10 && duration > 0 && target < duration - 5) {
            art.currentTime = target;
            art.notice.show = `已为你跳转到上次观看位置 ${formatTime(target)}`;
        } else {
            // 没有可用的续播位置才跳片头；已经看过的部分不往回跳
            const introSkip = readIntroSkip(currentVideoTitle);
            if (introSkip > 0 && duration > introSkip + 10) {
                art.currentTime = introSkip;
                art.notice.show = `已跳过片头 ${formatTime(introSkip)}`;
            }
        }
        // mp4/flv 等单码率源拿不到 hls.levels，用视频元素的真实尺寸兜底
        if (!art.hls && art.video.videoHeight) {
            updateResolutionBadge(formatResolution(art.video.videoWidth, art.video.videoHeight));
        }
        setTimeout(saveToHistory, 3000);
        startProgressSaveInterval();
    });

    art.on('video:playing', () => {
        playbackStarted = true;
        hidePlayerError();
        clearTimeout(slowLoadTimer);
        requestScreenAwake(true);
    });

    art.on('video:pause', () => {
        saveCurrentProgress();
        requestScreenAwake(false);
    });

    art.on('video:error', () => {
        if (!playbackStarted && getVideoType(currentVideoUrl) !== 'm3u8') {
            handleSourceFailure();
        }
    });

    art.on('video:ended', () => {
        videoHasEnded = true;
        clearVideoProgress();
        requestScreenAwake(false);
        if (autoplayEnabled && currentEpisodeIndex < currentEpisodes.length - 1) {
            art.notice.show = '即将播放下一集';
            setTimeout(() => {
                if (videoHasEnded) playNextEpisode();
            }, 1000);
        }
    });

    art.on('fullscreenWeb', (state) => {
        document.body.classList.toggle('player-fullscreen', !!state);
        if (androidBridge) {
            const portraitVideo = art.video.videoHeight > art.video.videoWidth;
            try { androidBridge.setFullscreen(!!state, !portraitVideo); } catch (e) { console.warn('setFullscreen failed', e); }
        }
    });

    window.addEventListener('pagehide', () => {
        if (androidBridge && art && art.fullscreenWeb) {
            try { androidBridge.setFullscreen(false, false); } catch (e) { /* ignore */ }
        }
    });

    art.on('fullscreen', (state) => {
        if (isTauriApp() && !androidBridge) {
            tauriInvoke('set_window_fullscreen', { fullscreen: !!state }).catch(e => console.warn('set_window_fullscreen failed', e));
        }
    });

    art.on('destroy', () => destroyStreamEngines(art));

    armSlowLoadHint();
}

// Called by the Android activity when the back key is pressed while the player is fullscreen.
window.__libretvNativeBack = function () {
    if (art && art.fullscreenWeb) { art.fullscreenWeb = false; return true; }
    if (art && art.fullscreen) { art.fullscreen = false; return true; }
    return false;
};

function switchPlayerUrl(url, startPosition = 0) {
    playbackStarted = false;
    videoHasEnded = false;
    pendingSeekPosition = startPosition;
    hidePlayerError();
    if (!art) { initPlayer(url); return; }
    const type = getVideoType(url);
    if (type !== 'm3u8' && type !== 'flv') destroyStreamEngines(art);
    art.option.type = type;
    art.switchUrl(url).catch(e => console.warn('switchUrl failed', e));
    updateNextEpisodeControl();
    armSlowLoadHint();
}

function armSlowLoadHint() {
    clearTimeout(slowLoadTimer);
    slowLoadTimer = setTimeout(() => {
        if (playbackStarted || !art) return;
        // 起播过慢时给一个直接换源的出口，而不是只留一句提示
        art.notice.show = '加载较慢，正在查找更快的线路…';
        autoFindFasterSource();
    }, 12000);
}

// 后台探测其他源，找到更快的就提示用户切换，不打断当前播放
async function autoFindFasterSource() {
    if (typeof loadSwitchSources !== 'function') return;
    const token = Date.now();
    autoFindFasterSource.token = token;
    try {
        await loadSwitchSources();
    } catch (e) {
        return;
    }
    if (autoFindFasterSource.token !== token || playbackStarted || !art) return;
    const better = (switchSourceState.items || []).find(item => item.probe === 'ok' && item.source_code !== switchSourceContext().sourceCode);
    if (!better) return;
    art.notice.show = `已找到更快的线路：${better.source_name || better.source_code}，点「换源」可切换`;
}

function updateNextEpisodeControl() {
    if (!art || !art.template || !art.template.$player) return;
    const control = art.template.$player.querySelector('.art-control-next-episode');
    if (control) control.style.display = currentEpisodeIndex < currentEpisodes.length - 1 ? '' : 'none';
}

// 播放器角标显示当前真实分辨率，非 m3u8 源也能通过 video 元素拿到尺寸
function updateResolutionBadge(label) {
    if (!label) return;
    let badge = document.getElementById('playerResolutionBadge');
    if (!badge) {
        const container = document.getElementById('player');
        if (!container) return;
        badge = document.createElement('span');
        badge.id = 'playerResolutionBadge';
        badge.className = 'player-resolution-badge';
        // 全屏时播放器会被移到 body 下，角标跟随当前播放器容器
        container.appendChild(badge);
    }
    badge.textContent = label;
    // 全屏顶部条读的就是这个角标，切档后立刻同步，不等下一次时钟刷新
    if (typeof updateFsOverlay === 'function') updateFsOverlay();
}

async function requestScreenAwake(on) {
    const androidBridge = getAndroidBridge();
    if (androidBridge && typeof androidBridge.setKeepScreenOn === 'function') {
        try { androidBridge.setKeepScreenOn(!!on); } catch (e) { /* ignore */ }
        return;
    }
    try {
        if (on && 'wakeLock' in navigator && !screenWakeLock) {
            screenWakeLock = await navigator.wakeLock.request('screen');
            screenWakeLock.addEventListener('release', () => { screenWakeLock = null; });
        } else if (!on && screenWakeLock) {
            await screenWakeLock.release();
            screenWakeLock = null;
        }
    } catch (e) { /* not supported */ }
}

// 统一走这个 loader：播放列表要过滤广告，分片要落磁盘缓存，两件事都得经过这里。
// 广告过滤关掉时只是跳过 manifest 处理，分片缓存照旧生效。
// 先查整集下载，再查分片缓存：下载是用户主动要的离线文件，命中优先级更高
function lookupStoredSegment(key) {
    if (typeof downloadSegmentGet !== 'function') return segmentCacheGet(key);
    return downloadSegmentGet(key).then(record => {
        if (record && record.data && record.data.byteLength) return record.data;
        return segmentCacheGet(key);
    }).catch(() => segmentCacheGet(key));
}

class CustomHlsJsLoader extends Hls.DefaultConfig.loader {
    constructor(config) {
        super(config);
        const load = this.load.bind(this);
        const loaderStats = this.stats;
        // hls.js 的 abort 只在已经发出 XHR 时才把 stats.aborted 置位（xhr.readyState !== 4）。
        // 我们在查 IndexedDB 时还没发请求，loader 是 null，那个标志永远不会置上，
        // 所以自己拦 abort/destroy 记一个标记，否则 abort 之后还会白发起一次网络请求。
        this.cacheAborted = false;
        const abort = this.abort;
        const destroy = this.destroy;
        this.abort = function () {
            this.cacheAborted = true;
            return abort.apply(this, arguments);
        };
        this.destroy = function () {
            this.cacheAborted = true;
            return destroy.apply(this, arguments);
        };
        this.load = function (context, loadConfig, callbacks) {
            if (context.type === 'manifest' || context.type === 'level') {
                const onSuccess = callbacks.onSuccess;
                callbacks.onSuccess = function (response, stats, ctx, networkDetails) {
                    if (response.data && typeof response.data === 'string') {
                        // 广告过滤关掉时也走一遍：只统计标记，不改内容，诊断信息才有数据可看
                        const filtering = typeof adFilteringEnabled === 'undefined' ? true : adFilteringEnabled;
                        response.data = filterAdsFromM3U8(response.data, filtering, response.url);
                    }
                    return onSuccess(response, stats, ctx, networkDetails);
                };
            }
            if (typeof isSegmentCacheCandidate !== 'function' || !isSegmentCacheCandidate(context)) {
                load(context, loadConfig, callbacks);
                return;
            }
            const self = this;
            // 网络路径：拿到分片时顺手存一份，再交给 hls.js
            const goNetwork = () => {
                const netOnSuccess = callbacks.onSuccess;
                callbacks.onSuccess = function (response, stats, ctx, networkDetails) {
                    if (typeof storeSegmentFromResponse === 'function') storeSegmentFromResponse(context, response);
                    return netOnSuccess(response, stats, ctx, networkDetails);
                };
                load(context, loadConfig, callbacks);
            };
            // IndexedDB 是异步的，查表期间 hls.js 可能已经 abort 掉这次请求（用户又拖了进度条）
            let settled = false;
            const startNetwork = () => {
                if (settled) return;
                settled = true;
                if (self.cacheAborted || (loaderStats && loaderStats.aborted)) return;
                goNetwork();
            };
            lookupStoredSegment(segmentCacheKey(context)).then(buffer => {
                if (settled) return;
                if (self.cacheAborted) {
                    settled = true;
                    return;
                }
                if (buffer && buffer.byteLength) {
                    settled = true;
                    segmentCacheNoteHit(buffer.byteLength);
                    try {
                        callbacks.onSuccess(
                            { url: context.url, data: buffer, code: 200 },
                            prepareSegmentCacheStats(loaderStats, buffer.byteLength),
                            context,
                            null
                        );
                        return;
                    } catch (e) {
                        // 喂给 hls.js 失败就退回网络，不要让一次异常把播放打断
                        settled = false;
                    }
                }
                segmentCacheNoteMiss();
                startNetwork();
            }).catch(startNetwork);
        };
    }
}

// 播放列表里的广告标记统计，落到 localStorage 给设置页的诊断信息读。
// 各采集站用的标记不一样（有的只给 CUE-OUT，有的只给 DISCONTINUITY，有的用 DATERANGE），
// 没有这份数据就没法判断该按哪种规则去广告，只能靠猜。
const PLAYLIST_MARKER_STATS_KEY = 'playlistMarkerStats';

// mode: 'cue' 按 CUE 标记删的 / 'structure' 按断点+域名结构删的 / 'none' 没动手
function recordPlaylistMarkers(raw, removedSegments, aborted, mode, adBlocks) {
    if (typeof raw !== 'string' || !raw) return;
    const count = pattern => (raw.match(pattern) || []).length;
    const payload = {
        at: Date.now(),
        bytes: raw.length,
        segments: count(/#EXTINF/g),
        discontinuity: count(/#EXT-X-DISCONTINUITY(?!-SEQUENCE)/g),
        cueOut: count(/#EXT-X-CUE-OUT/g),
        cueIn: count(/#EXT-X-CUE-IN/g),
        daterange: count(/#EXT-X-DATERANGE/g),
        scte35: count(/#(?:EXT-X-SCTE35|EXT-OATCLS-SCTE35)/g),
        removed: removedSegments || 0,
        aborted: !!aborted,
        mode: mode || 'none',
        adBlocks: adBlocks || 0
    };
    try { localStorage.setItem(PLAYLIST_MARKER_STATS_KEY, JSON.stringify(payload)); } catch (e) { /* 存不下就算了 */ }
}

// 采集站 SSAI 插播广告的结构特征：广告是一整块被 #EXT-X-DISCONTINUITY 夹住的分片，
// 分片全部指向另一个域名（广告商的 CDN），块内还常带一句 #EXT-X-KEY:METHOD=NONE。
// 这类源不会给 CUE-OUT/CUE-IN，所以只能靠结构认。
const AD_BLOCK_MAX_SECONDS = 180;
// 删掉的分片超过总量这个比例，说明判定规则在误伤正片，宁可放弃
const AD_REMOVE_MAX_RATIO = 0.3;

function isDiscontinuityLine(text) {
    return text === '#EXT-X-DISCONTINUITY' || text.indexOf('#EXT-X-DISCONTINUITY:') === 0;
}

// 把播放列表按断点标记切成块，每块记录自己的分片、时长、以及前面有没有断点
function splitPlaylistBlocks(lines) {
    const blocks = [];
    let block = { discontinuity: false, lines: [], segments: [], duration: 0 };
    let pending = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (isDiscontinuityLine(trimmed)) {
            blocks.push(block);
            block = { discontinuity: true, lines: [], segments: [], duration: 0 };
            continue;
        }
        block.lines.push(line);
        if (trimmed.indexOf('#EXTINF') === 0) {
            const value = parseFloat(trimmed.slice(8));
            pending = isNaN(value) ? 0 : value;
            continue;
        }
        // 非 # 开头的非空行就是分片地址
        if (trimmed && trimmed.charAt(0) !== '#') {
            block.segments.push({ uri: trimmed, duration: pending });
            block.duration += pending;
            pending = 0;
        }
    }
    blocks.push(block);
    return blocks;
}

function playlistHost(uri, baseUrl) {
    try {
        const resolved = new URL(uri, baseUrl || 'https://placeholder.invalid/');
        return resolved.host || '';
    } catch (e) {
        return '';
    }
}

// 结构法：断点夹住、分片全在别的域名上、且整块很短的，判定为广告块，整块删掉。
// 删的时候连同块前那个断点一起丢，让下一个保留块自己的断点顶上，
// 正片前后正好剩一个断点——时间轴需要它重新对齐，少了会出现缓冲空洞。
function filterByStructure(m3u8Content, lines, baseUrl, applyFilter) {
    const blocks = splitPlaylistBlocks(lines);
    let totalSegments = 0;
    let totalDuration = 0;
    blocks.forEach(block => block.segments.forEach(segment => {
        totalSegments += 1;
        totalDuration += segment.duration;
    }));
    // 判广告不看「哪个域名分片多」——广告块比正片块长时那个判据会反过来。
    // 改成「这块用的域名，前面的正片一个都没用过」：广告和正片永远不在同一个域名上。
    const contentHosts = new Set();
    const dropped = [];
    blocks.forEach((block, index) => {
        if (!block.segments.length) return;
        const hosts = block.segments.map(segment => playlistHost(segment.uri, baseUrl));
        const resetKey = block.lines.some(line => line.trim().indexOf('#EXT-X-KEY:METHOD=NONE') === 0);
        const short = block.duration > 0 && block.duration <= AD_BLOCK_MAX_SECONDS;
        const disjoint = hosts.every(host => !contentHosts.has(host));
        // 没有前置断点就不是插播块：这一条保证「没有断点标记的播放列表一律不动」
        const isAd = block.discontinuity && short && (disjoint || resetKey);
        if (isAd) {
            dropped.push(index);
            return;
        }
        hosts.forEach(host => contentHosts.add(host));
    });
    if (!dropped.length) {
        recordPlaylistMarkers(m3u8Content, 0, false, 'none', 0);
        return m3u8Content;
    }
    let removedSegments = 0;
    let removedDuration = 0;
    dropped.forEach(index => {
        removedSegments += blocks[index].segments.length;
        removedDuration += blocks[index].duration;
    });
    // 兜底：删太多说明判定规则不对，宁可让用户看广告也不能把正片删没
    const tooMuch = removedSegments >= totalSegments || removedDuration > totalDuration * AD_REMOVE_MAX_RATIO;
    if (tooMuch || !applyFilter) {
        recordPlaylistMarkers(m3u8Content, 0, tooMuch, tooMuch ? 'none' : 'structure', dropped.length);
        return m3u8Content;
    }
    const kept = [];
    const tail = [];
    let emitted = 0;
    blocks.forEach((block, index) => {
        if (dropped.indexOf(index) >= 0) {
            // 尾部广告块里带着 #EXT-X-ENDLIST，整块丢掉会连播放结束标记一起丢
            block.lines.forEach(line => {
                if (line.trim() === '#EXT-X-ENDLIST') tail.push(line);
            });
            return;
        }
        // 头一个分片之前不需要断点，写了反而是个孤立标记
        if (block.discontinuity && emitted > 0) kept.push('#EXT-X-DISCONTINUITY');
        block.lines.forEach(line => kept.push(line));
        emitted += block.segments.length;
    });
    tail.forEach(line => kept.push(line));
    recordPlaylistMarkers(m3u8Content, removedSegments, false, 'structure', dropped.length);
    return kept.join('\n');
}

// 按 SCTE-35 广告标记把标记区间内的分片整段删掉（#EXT-X-CUE-OUT … #EXT-X-CUE-IN）。
// 早先的实现只删 #EXT-X-DISCONTINUITY 这一行标签、一个分片都不删，所以从来没真正去掉过广告；
// 反过来删标签还会让 remuxer 按连续时间戳算分段，导致缓冲出现空洞。现在标签一律保留，只删分片。
function filterAdsFromM3U8(m3u8Content, applyFilter, baseUrl) {
    if (!m3u8Content) return '';
    const lines = m3u8Content.split('\n');
    // 有 CUE 标记就走标记法，没有就走结构法（采集站插播广告不给 CUE 标记）
    const hasCueOut = lines.some(line => line.trim().indexOf('#EXT-X-CUE-OUT') === 0);
    if (!hasCueOut) return filterByStructure(m3u8Content, lines, baseUrl, applyFilter);
    if (!applyFilter) {
        recordPlaylistMarkers(m3u8Content, 0, false, 'cue', 0);
        return m3u8Content;
    }
    const kept = [];
    let inAd = false;
    let removed = 0;
    let sawCueIn = false;
    let pendingBreak = false;
    let insertBreak = false;
    // 已经保留的最后一行是不是 DISCONTINUITY：决定广告断点处要不要补标记
    const lastKeptIsDiscontinuity = () => {
        for (let i = kept.length - 1; i >= 0; i--) {
            const t = kept[i].trim();
            if (!t) continue;
            return t.indexOf('#EXT-X-DISCONTINUITY') === 0;
        }
        return true;
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        // CUE-OUT-CONT 也是以 CUE-OUT 开头，一并算作广告区间内
        if (trimmed.indexOf('#EXT-X-CUE-OUT') === 0) {
            inAd = true;
            continue;
        }
        if (trimmed.indexOf('#EXT-X-CUE-IN') === 0) {
            inAd = false;
            sawCueIn = true;
            pendingBreak = true;
            continue;
        }
        if (inAd) {
            if (trimmed.indexOf('#EXTINF') === 0) removed += 1;
            continue;
        }
        if (pendingBreak) {
            if (!trimmed) continue;
            pendingBreak = false;
            if (trimmed.indexOf('#EXT-X-DISCONTINUITY') === 0) {
                // 广告段后紧跟的 DISCONTINUITY：前面已经有了就合并成一个，没有就留着这个
                if (lastKeptIsDiscontinuity()) continue;
                kept.push(line);
                continue;
            }
            // 广告前后都没打断点标记，下一个分片前补一个：广告分片与正片的时间戳不连续，
            // 不标出来的话 remuxer 会按连续时间戳算分段时长，缓冲区里出现空洞
            insertBreak = !lastKeptIsDiscontinuity();
        }
        // 断点标记要落在分片前面，且后面没有分片时不必补（否则 ENDLIST 前会多一行空断点）
        if (insertBreak && trimmed.indexOf('#EXTINF') === 0) {
            kept.push('#EXT-X-DISCONTINUITY');
            insertBreak = false;
        }
        kept.push(line);
    }
    // 标记不成对（没有 CUE-IN）说明结构不符合预期，宁可不动，别把正片删了
    if (!sawCueIn) {
        recordPlaylistMarkers(m3u8Content, 0, false, 'cue', 0);
        return m3u8Content;
    }
    // 兜底：标记打错位置时会一口气删掉大半正片，超过三成就当标记不可信，原样放行。
    // 宁可让用户看广告，也不能把正片删没。
    const totalSegments = lines.reduce((n, l) => (l.trim().indexOf('#EXTINF') === 0 ? n + 1 : n), 0);
    if (removed > 5 && removed > totalSegments * 0.3) {
        recordPlaylistMarkers(m3u8Content, 0, true, 'cue', 0);
        return m3u8Content;
    }
    recordPlaylistMarkers(m3u8Content, removed, false, 'cue', 0);
    return kept.join('\n');
}
