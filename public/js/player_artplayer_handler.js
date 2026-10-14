// ArtPlayer Handler Logic

const PLAYER_ICONS = {
    next: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 6.5v11a1 1 0 0 0 1.52.85l8.5-5.5a1 1 0 0 0 0-1.7l-8.5-5.5A1 1 0 0 0 6 6.5zM17 6h2v12h-2z"/></svg>',
    fullscreenOn: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM6 15v3h3v2H4v-5h2zm12 0h2v5h-5v-2h3v-3z"/></svg>',
    fullscreenOff: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M7 4h2v5H4V7h3V4zm8 0h2v3h3v2h-5V4zM4 15h5v5H7v-3H4v-2zm11 0h5v2h-3v3h-2v-5z"/></svg>'
};

const HLS_CONFIG = {
    debug: false,
    enableWorker: true, lowLatencyMode: false, backBufferLength: 90,
    maxBufferLength: 30, maxMaxBufferLength: 60, maxBufferSize: 30 * 1000 * 1000,
    maxBufferHole: 0.5, fragLoadingMaxRetry: 6, fragLoadingMaxRetryTimeout: 64000,
    fragLoadingRetryDelay: 1000, manifestLoadingMaxRetry: 3, manifestLoadingRetryDelay: 1000,
    levelLoadingMaxRetry: 4, levelLoadingRetryDelay: 1000, startLevel: -1,
    abrEwmaDefaultEstimate: 500000, abrBandWidthFactor: 0.95, abrBandWidthUpFactor: 0.7,
    abrMaxWithRealBitrate: true, stretchShortVideoTrack: true, appendErrorMaxRetry: 5,
    liveSyncDurationCount: 3, liveDurationInfinity: false
};

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
}

function playM3u8(video, url, instance) {
    destroyStreamEngines(instance);
    if (!window.Hls || !Hls.isSupported()) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) { video.src = url; return; }
        showPlayerError('当前环境不支持播放 m3u8 视频');
        return;
    }
    const hls = new Hls({
        ...HLS_CONFIG,
        loader: adFilteringEnabled ? CustomHlsJsLoader : Hls.DefaultConfig.loader
    });
    let fatalRecoverCount = 0;
    let bufferAppendErrorCount = 0;
    hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.details === 'bufferAppendError') {
            bufferAppendErrorCount++;
            if (!playbackStarted && bufferAppendErrorCount >= 3) hls.recoverMediaError();
            return;
        }
        if (!data.fatal) return;
        fatalRecoverCount++;
        if (fatalRecoverCount > 3) {
            if (!playbackStarted) showPlayerError('视频加载失败，可能是线路失效或格式不兼容');
            return;
        }
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else if (!playbackStarted) showPlayerError('视频加载失败，可能是线路失效或格式不兼容');
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

function buildPlayerSettings() {
    const savedFit = localStorage.getItem('playerObjectFit') || 'contain';
    return [{
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
    }];
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
        icons: androidBridge ? { fullscreenWebOn: PLAYER_ICONS.fullscreenOn, fullscreenWebOff: PLAYER_ICONS.fullscreenOff } : {},
        controls: [{
            name: 'next-episode',
            position: 'left',
            index: 15,
            html: PLAYER_ICONS.next,
            tooltip: '下一集',
            click: () => playNextEpisode()
        }],
        moreVideoAttr: { preload: 'auto', 'x5-video-player-type': 'h5' }
    });

    art.on('ready', () => {
        art.video.style.objectFit = localStorage.getItem('playerObjectFit') || 'contain';
        updateNextEpisodeControl();
    });

    art.on('video:loadedmetadata', () => {
        videoHasEnded = false;
        const duration = art.video.duration || 0;
        const target = pendingSeekPosition;
        pendingSeekPosition = 0;
        if (target > 10 && duration > 0 && target < duration - 5) {
            art.currentTime = target;
            art.notice.show = `已为你跳转到上次观看位置 ${formatTime(target)}`;
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
            showPlayerError('视频加载失败，可能是线路失效或格式不兼容');
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
        if (!playbackStarted && art) art.notice.show = '加载较慢，可尝试切换线路或换源';
    }, 12000);
}

function updateNextEpisodeControl() {
    if (!art || !art.template || !art.template.$player) return;
    const control = art.template.$player.querySelector('.art-control-next-episode');
    if (control) control.style.display = currentEpisodeIndex < currentEpisodes.length - 1 ? '' : 'none';
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

class CustomHlsJsLoader extends Hls.DefaultConfig.loader {
    constructor(config) {
        super(config);
        const load = this.load.bind(this);
        this.load = function (context, loadConfig, callbacks) {
            if (context.type === 'manifest' || context.type === 'level') {
                const onSuccess = callbacks.onSuccess;
                callbacks.onSuccess = function (response, stats, ctx, networkDetails) {
                    if (response.data && typeof response.data === 'string') {
                        response.data = filterAdsFromM3U8(response.data);
                    }
                    return onSuccess(response, stats, ctx, networkDetails);
                };
            }
            load(context, loadConfig, callbacks);
        };
    }
}

function filterAdsFromM3U8(m3u8Content) {
    if (!m3u8Content) return '';
    return m3u8Content.split('\n').filter(line => !line.includes('#EXT-X-DISCONTINUITY')).join('\n');
}
