// ArtPlayer Handler Logic

const PLAYER_ICONS = {
    next: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M6 6.5v11a1 1 0 0 0 1.52.85l8.5-5.5a1 1 0 0 0 0-1.7l-8.5-5.5A1 1 0 0 0 6 6.5zM17 6h2v12h-2z"/></svg>',
    fullscreenOn: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M4 9V4h5v2H6v3H4zm11-5h5v5h-2V6h-3V4zM6 15v3h3v2H4v-5h2zm12 0h2v5h-5v-2h3v-3z"/></svg>',
    fullscreenOff: '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M7 4h2v5H4V7h3V4zm8 0h2v3h3v2h-5V4zM4 15h5v5H7v-3H4v-2zm11 0h5v2h-3v3h-2v-5z"/></svg>'
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
    const hls = new Hls({
        ...HLS_CONFIG,
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

function buildPlayerSettings() {
    const savedFit = localStorage.getItem('playerObjectFit') || 'contain';
    const gestureEnabled = isGestureEnabled();
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
    }, {
        html: '手势调节',
        tooltip: gestureEnabled ? '开' : '关',
        switch: gestureEnabled,
        onSwitch(item) {
            const enabled = !!item.switch;
            setGestureEnabled(enabled);
            return enabled ? '开' : '关';
        }
    }];
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
                    if (adFilteringEnabled && response.data && typeof response.data === 'string') {
                        response.data = filterAdsFromM3U8(response.data);
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
            segmentCacheGet(segmentCacheKey(context)).then(buffer => {
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

// 原实现会把 #EXT-X-DISCONTINUITY 整行删掉。这个标签是告诉 hls.js「下一片的时间戳会跳变，
// 需要重新对齐」的，删掉后 remuxer 会按连续时间戳算分段时长，缓冲区里因此出现空洞或重叠，
// 表现为播到某个位置就卡住。真正的广告过滤要按分片内容判断，做不到之前保持原样返回。
function filterAdsFromM3U8(m3u8Content) {
    return m3u8Content || '';
}
