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
let pendingVideoSeek = 0;
let pendingVideoSeekNotice = '';
let pendingVideoSeekTimer = null;
let slowLoadTimer = null;
let screenWakeLock = null;

function clearPendingVideoSeek() {
    pendingVideoSeek = 0;
    pendingVideoSeekNotice = '';
    if (pendingVideoSeekTimer) {
        clearInterval(pendingVideoSeekTimer);
        pendingVideoSeekTimer = null;
    }
}

// 直接写 video.currentTime，不走 art.currentTime。
// art 的 setter 会按 art.duration 夹紧，而 hls.js 刚切源时 video.duration 还是
// Infinity、art.duration 会读成 0，夹紧后等于 0，表现就是「跳转没反应」。
function tryPendingVideoSeek() {
    if (!pendingVideoSeek || !art || !art.video) return false;
    const video = art.video;
    const target = pendingVideoSeek;
    // 已经在目标之后（用户自己拖过去了）就别往回跳
    if (video.currentTime >= target - 1) {
        clearPendingVideoSeek();
        return true;
    }
    // 时长还没定下来、或者可跳范围还没铺到目标位置，都等下一次
    if (!Number.isFinite(video.duration) || video.duration <= target + 5) return false;
    const seekable = video.seekable;
    if (seekable && seekable.length && seekable.end(seekable.length - 1) <= target + 1) return false;
    const notice = pendingVideoSeekNotice;
    clearPendingVideoSeek();
    video.currentTime = target;
    if (notice && art.notice) art.notice.show = notice;
    return true;
}

// 切源之后要等元数据就绪才能跳，这里重试到能跳为止（最多 6 秒）
function scheduleVideoSeek(seconds, notice) {
    clearPendingVideoSeek();
    if (!(seconds > 0)) return;
    pendingVideoSeek = seconds;
    pendingVideoSeekNotice = notice || '';
    if (tryPendingVideoSeek()) return;
    let tries = 0;
    pendingVideoSeekTimer = setInterval(() => {
        tries += 1;
        if (tries > 24 || tryPendingVideoSeek()) clearPendingVideoSeek();
    }, 250);
}

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

function applyEpisodeDownloadToggle() {
    const result = toggleEpisodeDownload(currentEpisodeIndex);
    const message = (result && (result.message || result.reason)) || '无法下载这一集';
    if (art && art.notice) art.notice.show = message;
    if (typeof updateEpisodeDownloadBadges === 'function') updateEpisodeDownloadBadges();
}

function requestEpisodeDownload() {
    if (typeof toggleEpisodeDownload !== 'function') return;
    const downloaded = typeof isEpisodeDownloaded === 'function'
        && isEpisodeDownloaded(currentVideoTitle, currentEpisodeIndex);
    if (!downloaded) {
        applyEpisodeDownloadToggle();
        return;
    }
    // 已经下过的时候再点一下就是删除。这个入口现在在全屏顶部条上，
    // 全屏时误触代价大，所以先问一句再删。
    if (typeof showConfirmDialog !== 'function') {
        applyEpisodeDownloadToggle();
        return;
    }
    showConfirmDialog({
        title: '删除这一集的离线文件',
        message: '删掉之后再看要重新下载。已经下好的其它集不受影响。',
        confirmText: '删除'
    }).then(ok => {
        if (ok) applyEpisodeDownloadToggle();
    });
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
                scheduleVideoSeek(seconds, `已跳过片头 ${formatTime(seconds)}`);
            }
            return introSkipLabel(seconds);
        }
    }, {
        // ArtPlayer 的设置项带 onClick 会渲染成一个可点的按钮。
        // 片头标记按钮从控制条挪走后，这里留一个不进全屏也能点到的入口。
        name: 'intro-mark',
        html: '以当前位置为片头结束',
        width: 200,
        tooltip: introSkipLabel(savedIntroSkip),
        onClick() {
            return markIntroEndHere();
        }
    }];
    // ArtPlayer 给设置项定义了 tooltip 的 setter，控制条上标记之后能实时改这里的显示
    introSkipSettingItem = items.find(item => item.name === 'intro-skip') || null;
    // 投屏入口：齿轮菜单里也放一个（仅 Tauri 壳等支持投屏的环境出现，buttonConfig()
    // 为 null 的环境不会加这一项）。点击后反馈走播放器顶部通知（搜索设备/已投屏/已停止）。
    if (window.PlayerCast && PlayerCast.buttonConfig()) {
        items.push({
            name: 'cast',
            html: '投屏到电视',
            width: 200,
            tooltip: 'DLNA',
            onClick() {
                PlayerCast.toggleDlna(art);
                return '投屏到电视';
            }
        });
        // 诊断入口：投屏搜不到/投不上时一键出报告，复制全文即可排查
        items.push({
            name: 'cast-diagnostics',
            html: '投屏诊断',
            width: 200,
            tooltip: '诊断',
            onClick() {
                PlayerCast.runDiagnostics(art);
                return '投屏诊断';
            }
        });
        // 本地视频播放：系统文件选择器 → 本机起服务 → 在 App 内直接播放；
        // 投屏复用本菜单里的「投屏到电视」，无需在此重复投屏逻辑
        items.push({
            name: 'local-video',
            html: '本地视频播放',
            width: 200,
            tooltip: '本地文件',
            onClick() {
                PlayerCast.pickAndPlayLocalVideo(art);
                return '本地视频播放';
            }
        });
        // VIP 解析播放：粘贴 VIP 视频页面 URL（用可配置解析接口取回可播地址），
        // 或输入关键词检索资源站结果；都只在 App 内播放，投屏复用「投屏到电视」
        items.push({
            name: 'vip-resolve',
            html: 'VIP 解析播放',
            width: 200,
            tooltip: '解析/搜索',
            onClick() {
                PlayerCast.openResolvePlay(art);
                return 'VIP 解析播放';
            }
        });
    }
    // 人工标记广告片段：与长按画面同一面板，桌面端鼠标长按不便时的入口
    if (window.PlayerAdMarker) {
        items.push({
            name: 'ad-mark',
            html: '标记广告片段',
            width: 200,
            tooltip: '手动跳过',
            onClick() {
                PlayerAdMarker.open(art);
                return '标记广告片段';
            }
        });
    }
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

// 全屏顶部条和设置面板里的「以当前位置为片头结束」：
// 播到片头结束那一刻点一下，就把这个秒数记给当前这部剧
function markIntroEndHere() {
    if (!art || !art.video) return '不可用';
    if (!currentVideoTitle) {
        if (art.notice) art.notice.show = '还不知道这是哪部剧，先播一会儿再试';
        return '未知';
    }
    const seconds = Math.floor(art.video.currentTime || 0);
    if (seconds < 10) {
        if (art.notice) art.notice.show = '当前位置太靠前，拖到片头结束的地方再点';
        return '太靠前';
    }
    const duration = art.video.duration || 0;
    if (duration > 0 && seconds > duration - 30) {
        if (art.notice) art.notice.show = '已经接近结尾了，这里不像片头结束的位置';
        return '接近结尾';
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
    // 返回值会变成设置面板那一行右侧的提示文字
    return introSkipLabel(seconds);
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
    // Android 壳里锁按钮整体外移一点，避开挖孔屏摄像头（配合 player.css 的安全区规则）
    document.body.classList.toggle('art-android', !!androidBridge);
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
        // Safari（macOS/iOS）上启用 AirPlay 按钮；Chromecast 走下面的自定义投屏按钮
        airplay: !androidBridge,
        settings: buildPlayerSettings(),
        plugins: [buildHlsControlPlugin()].filter(Boolean),
        icons: androidBridge ? { fullscreenWebOn: PLAYER_ICONS.fullscreenOn, fullscreenWebOff: PLAYER_ICONS.fullscreenOff } : {},
        // 控制条自定义按钮：投屏（由 PlayerCast.buttonConfig() 按环境决定：
        // Tauri 壳 -> DLNA；桌面 Chrome/Edge -> Chromecast；不占手机空间）+ 下一集。
        // 之前这里还挂了下载和片头标记，361px 宽的手机上会把「全屏」按钮挤出屏幕，
        // 两个动作都挪到全屏顶部条去了。
        controls: [
            ...(window.PlayerCast && PlayerCast.buttonConfig() ? [PlayerCast.buttonConfig()] : []),
            {
                name: 'next-episode',
                position: 'left',
                index: 15,
                html: PLAYER_ICONS.next,
                tooltip: '下一集',
                click: () => playNextEpisode()
            }
        ],
        moreVideoAttr: { preload: 'auto', 'x5-video-player-type': 'h5' }
    });

    // 提前加载 Cast SDK：等用户第一次点按钮再加载会有几秒延迟
    if (window.PlayerCast) PlayerCast.init();

    art.on('ready', () => {
        art.video.style.objectFit = localStorage.getItem('playerObjectFit') || 'contain';
        updateNextEpisodeControl();
        // ArtPlayer 会重建容器内容，遮罩和手势要在 ready 之后再挂
        if (typeof setupPlayerGestures === 'function') setupPlayerGestures();
        if (typeof setupPlayerBuffer === 'function') setupPlayerBuffer(art);
        if (typeof setupFullscreenOverlay === 'function') setupFullscreenOverlay(art);
        if (typeof setupSeekPill === 'function') setupSeekPill(art);
        // 人工标记广告：长按画面弹出标记面板（自动规则漏掉的切片广告由用户兜底）
        if (window.PlayerAdMarker) PlayerAdMarker.attach(art);
    });

    art.on('video:loadedmetadata', () => {
        videoHasEnded = false;
        const duration = art.video.duration || 0;
        const target = pendingSeekPosition;
        pendingSeekPosition = 0;
        if (target > 10 && duration > 0 && target < duration - 5) {
            scheduleVideoSeek(target, `已为你跳转到上次观看位置 ${formatTime(target)}`);
        } else {
            // 没有可用的续播位置才跳片头；已经看过的部分不往回跳
            const introSkip = readIntroSkip(currentVideoTitle);
            if (introSkip > 0) scheduleVideoSeek(introSkip, `已跳过片头 ${formatTime(introSkip)}`);
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
    // 换集/换源时把上一集没来得及执行的跳转作废，否则会跳错位置
    clearPendingVideoSeek();
    pendingSeekPosition = startPosition;
    hidePlayerError();
    if (!art) { initPlayer(url); return; }
    const type = getVideoType(url);
    if (type !== 'm3u8' && type !== 'flv') destroyStreamEngines(art);
    art.option.type = type;
    // switchUrl 解析后 duration 才是新片源的，这里补一次兜底，
    // 免得 loadedmetadata 没触发时片头跳过完全失效
    art.switchUrl(url).then(() => {
        const introSkip = startPosition > 0 ? 0 : readIntroSkip(currentVideoTitle);
        if (introSkip > 0) scheduleVideoSeek(introSkip, `已跳过片头 ${formatTime(introSkip)}`);
    }).catch(e => console.warn('switchUrl failed', e));
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
                        // 过滤前的原始清单留存一份：人工标记要靠它算出广告块的准确起止，
                        // 过滤后清单已经缺了广告分片，事后无从还原边界。
                        rememberRawPlaylist(response.data, response.url);
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

// ============ 原始播放列表留存（人工标记自动定边界用）============
// 过滤前的原始清单是唯一的「广告块边界」证据：过滤之后广告分片已经不在清单里，
// 事后无从知道广告到底从哪开始、到哪结束。这里按清单地址缓存最近一次的原始清单。
const rawPlaylistCache = new Map(); // key: 清单地址 → { blocks, segments, totalDuration, at }
const RAW_PLAYLIST_CACHE_MAX = 4;

function playlistCacheKey(baseUrl) {
    try {
        const u = new URL(baseUrl, location.href);
        // 去掉 token 查询参数：同一个清单换 token 仍是同一份内容
        return u.origin + u.pathname;
    } catch (e) {
        return String(baseUrl || '');
    }
}

// 把原始清单解析成「块 + 分片」结构，附带每个分片的累计起止时间。
// 起止时间是 hls.js 的 frag.start 语义（EXTINF 累加），用来把播放时间反查成分片。
//
// 每个分片带一个 id（URI + 该 URI 在清单里的出现序号）：
// 广告分片常在片头片尾复用同一批文件名，只看 URI 分不清是哪一个，
// 时间轴换算必须靠这个唯一标识。
function parseRawPlaylist(m3u8Content, baseUrl) {
    const lines = m3u8Content.split('\n');
    const blocks = [];
    let block = { discontinuity: false, keyNone: false, segments: [], duration: 0 };
    let pending = 0;
    let clock = 0;
    const uriSeen = new Map();
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (isDiscontinuityLine(trimmed)) {
            blocks.push(block);
            block = { discontinuity: true, keyNone: false, segments: [], duration: 0 };
            continue;
        }
        if (trimmed.indexOf('#EXT-X-KEY') === 0) {
            if (trimmed.indexOf('METHOD=NONE') >= 0) block.keyNone = true;
            continue;
        }
        if (trimmed.indexOf('#EXTINF') === 0) {
            const value = parseFloat(trimmed.slice(8));
            pending = isNaN(value) ? 0 : value;
            continue;
        }
        if (trimmed && trimmed.charAt(0) !== '#') {
            const occurrence = uriSeen.get(trimmed) || 0;
            uriSeen.set(trimmed, occurrence + 1);
            const seg = {
                uri: trimmed,
                id: segmentIdentity(trimmed, occurrence),
                occurrence: occurrence,
                duration: pending,
                start: clock,
                end: clock + pending,
                host: playlistHost(trimmed, baseUrl),
                // 路径前缀：同一个 CDN 下的分片共享前缀，广告常用另一个前缀
                pathPrefix: playlistPathPrefix(trimmed)
            };
            block.segments.push(seg);
            block.duration += pending;
            clock += pending;
            pending = 0;
        }
    }
    blocks.push(block);
    return {
        blocks: blocks,
        segments: blocks.reduce((acc, b) => acc.concat(b.segments), []),
        totalDuration: clock,
        baseUrl: baseUrl,
        at: Date.now()
    };
}

// 分片的路径前缀（去掉最后一级文件名）：广告块常整块来自另一个目录
function playlistPathPrefix(uri) {
    try {
        const u = new URL(uri, 'https://placeholder.invalid/');
        const path = u.pathname.replace(/[^/]*$/, '');
        return u.host + path;
    } catch (e) {
        return '';
    }
}

function rememberRawPlaylist(m3u8Content, baseUrl) {
    if (!m3u8Content || !baseUrl) return;
    try {
        const key = playlistCacheKey(baseUrl);
        const parsed = parseRawPlaylist(m3u8Content, baseUrl);
        rawPlaylistCache.set(key, parsed);
        lastRawPlaylist = parsed;
        while (rawPlaylistCache.size > RAW_PLAYLIST_CACHE_MAX) {
            // Map 保持插入顺序，删最早写入的那个
            const oldest = rawPlaylistCache.keys().next().value;
            rawPlaylistCache.delete(oldest);
        }
    } catch (e) { /* 解析失败就算了，不影响播放 */ }
}

// 对外：供 player_ad_marker.js 查询当前播放列表的分片结构
// 注意：hls.url 指向的是 master 清单，而缓存的键是媒体清单（第二层）的地址，
// 两者对不上。同一时刻只有一个列表在播，所以查不到时退回最近缓存的那份。
let lastRawPlaylist = null;

function getRawPlaylist(baseUrl) {
    const key = playlistCacheKey(baseUrl);
    const hit = rawPlaylistCache.get(key);
    if (hit) return hit;
    if (lastRawPlaylist) return lastRawPlaylist;
    return null;
}

// ============ M3U8 广告过滤（标记法 + 结构法 + 主机特征法 + 学习型黑名单）============// 采集站 SSAI 插播广告的结构特征：广告是一整块被 #EXT-X-DISCONTINUITY 夹住的分片，
// 分片全部指向另一个域名（广告商的 CDN），块内还常带一句 #EXT-X-KEY:METHOD=NONE。
// 这类源不会给 CUE-OUT/CUE-IN，所以只能靠结构认。
// 块长上限放宽到 300s：180s 会放过 3~5 分钟的广告组；
// 误伤风险由「广告域名必须没在正片出现过」+ 30% 兜底比例挡住。
const AD_BLOCK_MAX_SECONDS = 300;
// 删掉的分片超过总量这个比例，说明判定规则在误伤正片，宁可放弃
const AD_REMOVE_MAX_RATIO = 0.3;

// ---- 主机特征法：按分片 URL 特征认广告，与断点结构无关 ----
// 现状弱点：很多采集站开始把广告分片放在与正片相同的 CDN 上（结构法的
// 「异域名」判据失效），或者干脆不打断点标记（结构法「一律不动」）。
// 这两种情况只能靠分片 URL 自身的特征认。关键词刻意收窄到
// 「路径里整段是广告词」的形态，避免 download/upload/header 这类误伤。
const AD_HOST_PATTERNS = [
    'doubleclick.net', 'googlesyndication', 'googleadservices', 'admob',
    'adnxs.com', 'pubmatic.com', 'rubiconproject.com', 'criteo.com',
    'adcolony', 'vungle.com', 'applovin', 'mopub.com', 'unityads', 'inmobi.com',
    'taboola.com', 'outbrain.com', 'moatads.com', 'amazon-adsystem',
    'tanx.com', 'mediav.com', 'miaozhen.com', 'ipinyou.com', 'adsame',
    'admaster', 'adview.cn', 'allyes.com', 'adchina.com'
];
const AD_PATH_PATTERN = /(^|\/)(ads?|adverts?|advertising|adcreative|adplayer|adframe|bannerads?|popunder|interstitial|preroll|midroll|postroll)(\/|$)/i;

function isAdSegmentUri(uri) {
    try {
        const resolved = new URL(uri, 'https://placeholder.invalid/');
        const host = (resolved.host || '').toLowerCase();
        for (let i = 0; i < AD_HOST_PATTERNS.length; i++) {
            if (host.indexOf(AD_HOST_PATTERNS[i]) >= 0) return true;
        }
        return AD_PATH_PATTERN.test(resolved.pathname);
    } catch (e) {
        return false;
    }
}

// ---- 学习型广告域名：结构法/标记法确认过的广告块域名记下来 ----
// 之后即使某站不打断点标记、广告直接拼进正片，只要域名是曾经确认过的
// 广告域名，也能删掉。过滤能力随使用越来越强。
const LEARNED_AD_HOSTS_KEY = 'learnedAdHosts';

function getLearnedAdHosts() {
    try {
        const raw = JSON.parse(localStorage.getItem(LEARNED_AD_HOSTS_KEY) || '[]');
        return Array.isArray(raw) ? raw.filter(h => typeof h === 'string' && h) : [];
    } catch (e) {
        return [];
    }
}

// 学习的前提是「这个域名没在本次保留的正片分片里出现过」：
// 同域名广告（靠路径特征删的）学域名会把正片域名拉黑，之后满盘误伤，必须排除。
function rememberAdHosts(adUris, keptUris, baseUrl) {
    const keptHosts = new Set();
    (keptUris || []).forEach(uri => {
        const host = playlistHost(uri, baseUrl);
        if (host) keptHosts.add(host);
    });
    const hosts = new Set(getLearnedAdHosts());
    (adUris || []).forEach(uri => {
        const host = playlistHost(uri, baseUrl);
        if (host && host !== 'placeholder.invalid' && !keptHosts.has(host)) hosts.add(host);
    });
    let list = Array.from(hosts);
    // 上限 64 个，超出保留最近确认的（Set 保持插入顺序，新确认的排在后面）
    if (list.length > 64) list = list.slice(list.length - 64);
    try { localStorage.setItem(LEARNED_AD_HOSTS_KEY, JSON.stringify(list)); } catch (e) { /* 存不下就算了 */ }
}

// 诊断统计在模块化版本里有、单文件版里没有，统一走这里，不存在就跳过
function recordAdFilterStats(raw, removed, aborted, mode, adBlocks) {
    if (typeof recordPlaylistMarkers === 'function') {
        recordPlaylistMarkers(raw, removed, aborted, mode, adBlocks);
    }
}

function isDiscontinuityLine(text) {
    return text === '#EXT-X-DISCONTINUITY' || text.indexOf('#EXT-X-DISCONTINUITY:') === 0;
}

// 把播放列表按断点标记切成块，每块记录自己的分片、时长、以及前面有没有断点
//
// 块上额外带三个字段，是给「广告块结构判据」用的：
//   keyNone —— 块内出现过 #EXT-X-KEY:METHOD=NONE（正片通常全程加密，广告块会切到明文）
//   segments[].pathPrefix —— 分片所在的 host+目录（广告块整块来自另一个目录）
//   segments[].start/end —— 该分片在原始清单时间轴上的位置
// 判据本身在 player_ad_locator.js（与「长按一次自动识别广告边界」共用一份实现）。
function splitPlaylistBlocks(lines) {
    const blocks = [];
    let block = { discontinuity: false, keyNone: false, lines: [], segments: [], duration: 0 };
    let pending = 0;
    let clock = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (isDiscontinuityLine(trimmed)) {
            blocks.push(block);
            block = { discontinuity: true, keyNone: false, lines: [], segments: [], duration: 0 };
            continue;
        }
        block.lines.push(line);
        if (trimmed.indexOf('#EXT-X-KEY') === 0) {
            if (trimmed.indexOf('METHOD=NONE') >= 0) block.keyNone = true;
            continue;
        }
        if (trimmed.indexOf('#EXTINF') === 0) {
            const value = parseFloat(trimmed.slice(8));
            pending = isNaN(value) ? 0 : value;
            continue;
        }
        // 非 # 开头的非空行就是分片地址
        if (trimmed && trimmed.charAt(0) !== '#') {
            block.segments.push({
                uri: trimmed,
                duration: pending,
                pathPrefix: playlistPathPrefix(trimmed),
                start: clock,
                end: clock + pending
            });
            block.duration += pending;
            clock += pending;
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

// 主机特征法（第一道过滤）：
// - 有断点标记的播放列表按块删：块内任一分片命中广告 URL 特征或已学习广告域名，
//   整块删掉（连块内 KEY 行一起删，避免解密状态错乱）。
// - 完全没有断点标记的播放列表按分片删：只删 EXTINF+URI 对，# 行一律保留
//   （这类源几乎不带 KEY，时间轴误差由 30% 兜底比例管着），
//   并额外处理片头贴片：开头连续的非主导域名分片判为贴片广告。
function filterByHostRules(m3u8Content, lines, baseUrl, applyFilter) {
    const learned = new Set(getLearnedAdHosts());
    const hostHit = uri => isAdSegmentUri(uri) || learned.has(playlistHost(uri, baseUrl));
    const blocks = splitPlaylistBlocks(lines);
    const hasMarkers = blocks.some(block => block.discontinuity);
    if (hasMarkers) {
        const hitBlocks = [];
        let removedSegments = 0;
        let removedDuration = 0;
        let totalSegments = 0;
        let totalDuration = 0;
        blocks.forEach((block, index) => {
            block.segments.forEach(segment => {
                totalSegments += 1;
                totalDuration += segment.duration;
            });
            if (!block.segments.length) return;
            if (block.segments.some(segment => hostHit(segment.uri))) {
                hitBlocks.push(index);
                removedSegments += block.segments.length;
                removedDuration += block.duration;
            }
        });
        if (!hitBlocks.length) {
            recordAdFilterStats(m3u8Content, 0, false, 'none', 0);
            return m3u8Content;
        }
        // 兜底：删太多说明判定规则在误伤正片，宁可让用户看广告也不能把正片删没
        const tooMuch = removedSegments >= totalSegments || removedDuration > totalDuration * AD_REMOVE_MAX_RATIO;
        if (tooMuch || !applyFilter) {
            recordAdFilterStats(m3u8Content, 0, tooMuch, 'host', hitBlocks.length);
            return m3u8Content;
        }
        const kept = [];
        const tail = [];
        const keptUris = [];
        const adUris = [];
        let droppedBefore = false;
        blocks.forEach((block, index) => {
            if (hitBlocks.indexOf(index) >= 0) {
                droppedBefore = true;
                block.segments.forEach(segment => adUris.push(segment.uri));
                block.lines.forEach(line => {
                    if (line.trim() === '#EXT-X-ENDLIST') tail.push(line);
                });
                return;
            }
            // 被删块与保留块之间要有一个断点：被删块自己的前置断点借不到时，
            // 在下一个保留块前补一个。多余的断点最多触发一次 remux，不会卡住播放。
            if (droppedBefore && !block.discontinuity) kept.push('#EXT-X-DISCONTINUITY');
            droppedBefore = false;
            block.segments.forEach(segment => keptUris.push(segment.uri));
            block.lines.forEach(line => kept.push(line));
        });
        tail.forEach(line => kept.push(line));
        // 确认是广告的分片域名记入学习型黑名单（正片用过的域名不记）
        rememberAdHosts(adUris, keptUris, baseUrl);
        recordAdFilterStats(m3u8Content, removedSegments, false, 'host', hitBlocks.length);
        return kept.join('\n');
    }
    // ---- 无断点标记：按分片处理 ----
    // 先解析成分片流，统计各域名时长找出正片主导域名，再按规则删
    const items = [];
    let pendingExtinf = null;
    let pendingDuration = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.indexOf('#EXTINF') === 0) {
            const value = parseFloat(trimmed.slice(8));
            pendingDuration = isNaN(value) ? 0 : value;
            pendingExtinf = line;
            continue;
        }
        if (!trimmed || trimmed.charAt(0) === '#') {
            items.push({ tag: true, line });
            continue;
        }
        items.push({ tag: false, line, extinf: pendingExtinf, duration: pendingDuration, uri: trimmed });
        pendingExtinf = null;
        pendingDuration = 0;
    }
    const segItems = items.filter(item => !item.tag);
    const totalSegments = segItems.length;
    const totalDuration = segItems.reduce((n, item) => n + item.duration, 0);
    // 正片主导域名：分片总时长最长的域名（贴片广告比正片短得多，不会占主导）
    const hostDuration = new Map();
    segItems.forEach(item => {
        const host = playlistHost(item.uri, baseUrl);
        hostDuration.set(host, (hostDuration.get(host) || 0) + item.duration);
    });
    let dominantHost = '';
    let dominantDuration = 0;
    hostDuration.forEach((duration, host) => {
        if (duration > dominantDuration) {
            dominantHost = host;
            dominantDuration = duration;
        }
    });
    const droppedFlags = segItems.map(item => hostHit(item.uri));
    // 片头贴片：开头连续的非主导域名分片判为贴片广告。
    // 贴片总长超过块长上限就放弃这条规则，防止把「正片头在别的 CDN 上」的源误删。
    if (dominantHost) {
        let prerollDuration = 0;
        let prerollEnd = 0;
        for (let i = 0; i < droppedFlags.length; i++) {
            if (playlistHost(segItems[i].uri, baseUrl) === dominantHost) break; // 碰到正片就停
            if (!droppedFlags[i]) prerollDuration += segItems[i].duration;
            prerollEnd = i + 1;
        }
        if (prerollDuration > AD_BLOCK_MAX_SECONDS) prerollEnd = 0;
        for (let i = 0; i < prerollEnd; i++) droppedFlags[i] = true;
    }
    const adUris = [];
    const keptUris = [];
    let removedSegments = 0;
    let removedDuration = 0;
    segItems.forEach((item, index) => {
        if (!droppedFlags[index]) {
            keptUris.push(item.uri);
            return;
        }
        adUris.push(item.uri);
        removedSegments += 1;
        removedDuration += item.duration;
    });
    const tooMuch = !removedSegments || removedSegments >= totalSegments ||
        removedDuration > totalDuration * AD_REMOVE_MAX_RATIO;
    if (tooMuch || !applyFilter) {
        recordAdFilterStats(m3u8Content, 0, tooMuch, 'host', adUris.length ? 1 : 0);
        return m3u8Content;
    }
    const segItemIndex = new Map();
    segItems.forEach((item, index) => segItemIndex.set(item, index));
    const kept = [];
    let needBreak = false;
    items.forEach(item => {
        if (item.tag) {
            kept.push(item.line);
            return;
        }
        if (droppedFlags[segItemIndex.get(item)]) {
            needBreak = true; // 删过广告后，下一个保留分片前要补断点
            return;
        }
        if (needBreak) {
            kept.push('#EXT-X-DISCONTINUITY');
            needBreak = false;
        }
        if (item.extinf) kept.push(item.extinf);
        kept.push(item.line);
    });
    rememberAdHosts(adUris, keptUris, baseUrl);
    recordAdFilterStats(m3u8Content, removedSegments, false, 'host', 1);
    return kept.join('\n');
}

// 广告开始/结束标记：CUE-OUT/CUE-IN 之外，再认 HLS 标准里的
// #EXT-X-DATERANGE 带 SCTE35-OUT / SCTE35-IN 属性的写法（Adobe Primetime 式 SSAI）。
// 之前只认 CUE 标记，用 DATERANGE 打标的站过滤不掉。
function isAdStartTag(trimmed) {
    if (trimmed.indexOf('#EXT-X-CUE-OUT') === 0) return true;
    return trimmed.indexOf('#EXT-X-DATERANGE') === 0 && trimmed.indexOf('SCTE35-OUT=') >= 0;
}

function isAdEndTag(trimmed) {
    if (trimmed.indexOf('#EXT-X-CUE-IN') === 0) return true;
    return trimmed.indexOf('#EXT-X-DATERANGE') === 0 && trimmed.indexOf('SCTE35-IN=') >= 0;
}

// 结构法：认「整块就是广告」的插播块。
//
// 判据只有一份实现，放在 player_ad_locator.js（与「长按一次自动识别广告边界」共用），
// 这里只负责把它接进过滤流程、以及在删除后重建播放列表。
// 判据要点：断点夹住 + 块内无加密 KEY + 整块同一路径前缀 + 块内时长规整，
// 再加三道安全阀（时长 ≤300s、分片数 ≤40、该前缀时长占比 ≤30%）。
//
// 为什么不用更宽松的「域名不在正片域名集合里」：
// 那个判据在真实站源上精确率只有 1.8%（40 个清单误伤 760 块）——
// 正片域名集合只在非广告块上累积，首块之后「异域名」几乎恒真，整片正片被连锁误删。
// 宁可漏删广告，也不能删掉正片。
function filterByStructure(m3u8Content, lines, baseUrl, applyFilter) {
    const blocks = splitPlaylistBlocks(lines);
    let totalSegments = 0;
    let totalDuration = 0;
    blocks.forEach(block => block.segments.forEach(segment => {
        totalSegments += 1;
        totalDuration += segment.duration;
    }));
    const dropped = findAdBlockIndexes(blocks);
    if (!dropped.length) {
        recordAdFilterStats(m3u8Content, 0, false, 'none', 0);
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
        recordAdFilterStats(m3u8Content, 0, tooMuch, 'structure', dropped.length);
        return m3u8Content;
    }
    const kept = [];
    const tail = [];
    const keptUris = [];
    const adUris = [];
    let emitted = 0;
    blocks.forEach((block, index) => {
        if (dropped.indexOf(index) >= 0) {
            // 尾部广告块里带着 #EXT-X-ENDLIST，整块丢掉会连播放结束标记一起丢
            block.segments.forEach(segment => adUris.push(segment.uri));
            block.lines.forEach(line => {
                if (line.trim() === '#EXT-X-ENDLIST') tail.push(line);
            });
            return;
        }
        // 头一个分片之前不需要断点，写了反而是个孤立标记
        if (block.discontinuity && emitted > 0) kept.push('#EXT-X-DISCONTINUITY');
        block.segments.forEach(segment => keptUris.push(segment.uri));
        block.lines.forEach(line => kept.push(line));
        emitted += block.segments.length;
    });
    tail.forEach(line => kept.push(line));
    // 确认是广告的块，把分片域名记入学习型黑名单（正片用过的域名不记），下次无标记也能删
    rememberAdHosts(adUris, keptUris, baseUrl);
    recordAdFilterStats(m3u8Content, removedSegments, false, 'structure', dropped.length);
    return kept.join('\n');
}

// 用 locator 的严判据找出广告块，返回块下标。
//
// 片头贴片（第 0 块，前面没有断点标记）要单独处理：
// 判据里「必须有断点」是给正片兜底的安全线，对贴片不适用，所以这里放宽这一条，
// 但仍要求 KEY:NONE + 单一前缀 + 时长规整 + 全部安全阀，
// 并额外要求它的路径前缀不被其它任何块使用（贴片广告独占一个目录）。
// 缺了最后这条，普通播放列表的第一块（正好短、时长规整、独占前缀）会被误删。
function findAdBlockIndexes(blocks) {
    const locator = (typeof AdBlockLocator !== 'undefined') ? AdBlockLocator : (window.AdBlockLocator || null);
    if (!locator || typeof locator.findAdBlockCandidates !== 'function') return [];
    const playlist = {
        // 第 0 块标记成「带断点」，让贴片也能进候选；其余块的标记原样保留
        blocks: blocks.map((block, index) => index === 0
            ? Object.assign({}, block, { discontinuity: true })
            : block),
        segments: blocks.reduce((acc, block) => acc.concat(block.segments), [])
    };
    let candidates = [];
    try {
        candidates = locator.findAdBlockCandidates(playlist) || [];
    } catch (e) {
        return [];
    }
    const indexes = [];
    const headPrefix = blocks[0] && blocks[0].segments.length
        ? blocks[0].segments[0].pathPrefix
        : '';
    const headExclusive = !!headPrefix && blocks.slice(1).every(block =>
        block.segments.every(segment => segment.pathPrefix !== headPrefix));
    candidates.forEach(candidate => {
        const index = candidate.blockIndex;
        // 贴片：独占目录才认，否则放过
        if (index === 0) {
            if (headExclusive) indexes.push(index);
            return;
        }
        indexes.push(index);
    });
    return indexes;
}

// 记录本次过滤实际删掉的分片。
// 用途：把「原始清单时间轴」换算成「播放时间轴」——
// 删掉广告后后面的分片会前移，播放器看到的时间与原始清单差一个偏移量。
// 人工标记要按播放时间轴工作，否则标记区间会整体错位。
//
// 标识用「URI + 该 URI 在原始清单里的出现序号」而不是裸 URI：
// 广告分片常在片头片尾复用同一批文件名（实测：IdHH1Wg6.ts 等 4 个文件各出现两次），
// 只看 URI 会把片尾的广告误判成「已删除」，导致时间轴偏移算错。
let lastRemovedSegmentIds = new Set();

// 本次过滤删掉的分片地址（原始 URI 字面量）。投屏时要把这份名单传给代理侧，
// 由它在电视看到的清单里剔除对应分片。
let lastRemovedSegmentUris = [];

// 给一个分片分配「URI + 出现序号」的唯一标识
function segmentIdentity(uri, occurrence) {
    return uri + '#' + occurrence;
}

// 对外：本次过滤实际删掉的分片标识集合（用于原始时间轴 → 播放时间轴换算）
function getRemovedSegmentIds() {
    return lastRemovedSegmentIds;
}

// 对外：本次过滤实际删掉的分片地址列表（投屏用）。
//
// 投屏时代电视自己去拉流，浏览器侧的过滤对它完全无效 —— 广告会原样播到电视上。
// 所以要把「哪些分片是广告」带过去，由代理侧按这份名单剔除。
//
// 返回清单里的原始 URI 字面量（与清单里写的完全一致，不做地址解析）：
// 代理侧会同时按「原始字面量」和「解析后的绝对地址」两种形态匹配，
// 两种形态都认才能覆盖「绝对地址」与「相对路径」两类站源。
//
// 名单在过滤收尾时一并记下（computeRemovedSegmentIds），
// 不在取用时回头翻缓存 —— 缓存只留最近 4 份清单，
// 投屏时可能已经被别的清单挤掉，名单空了等于过滤没生效。
function getRemovedSegmentUris() {
    return lastRemovedSegmentUris;
}

// 对比「过滤后的清单」与「原始清单」，算出被删掉的分片标识。
//
// 为什么用比对而不是在过滤分支里登记：过滤有四条路径（主机特征法断点分支 /
// 无断点分支、标记法、结构法），每条都要登记一遍很容易漏；而且登记的是裸 URI，
// 遇到片头片尾复用同一批广告文件名的情况会算错。比对法只看最终结果，
// 与走了哪条过滤路径无关。
//
// 匹配用贪心：原始清单的分片按顺序依次在结果里找，找到就配对，找不到就判定被删。
// 广告是整块删除的，顺序不会被打乱，贪心匹配不会配错。
//
// 同时记下被删分片的 URI（供投屏用）：这里是唯一能同时拿到「原始清单」与
// 「过滤结果」的时刻，事后再去翻缓存可能已经被别的清单覆盖。
function computeRemovedSegmentIds(originalPlaylist, filteredText) {
    const removed = new Set();
    const removedUris = [];
    if (!originalPlaylist || !originalPlaylist.segments.length) return { removed, removedUris };
    // 结果清单里剩下的分片 URI 序列（按顺序）
    const keptUris = [];
    filteredText.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && trimmed.charAt(0) !== '#') keptUris.push(trimmed);
    });
    let keptIndex = 0;
    originalPlaylist.segments.forEach(seg => {
        if (keptIndex < keptUris.length && keptUris[keptIndex] === seg.uri) {
            keptIndex += 1; // 配上了，说明这个分片还在
            return;
        }
        removed.add(seg.id);
        removedUris.push(seg.uri);
    });
    return { removed, removedUris };
}

// 过滤收尾：算出这次删掉了哪些分片，供播放时间轴换算使用。
// 比对的是「过滤后的清单」与「原始清单」，与走了哪条过滤路径无关。
function finishFiltering(filteredText, baseUrl) {
    const original = getRawPlaylist(baseUrl);
    if (original) {
        const result = computeRemovedSegmentIds(original, filteredText);
        lastRemovedSegmentIds = result.removed;
        lastRemovedSegmentUris = result.removedUris;
    }
    return filteredText;
}

// 总入口。先走主机特征法（与结构无关，能抓同域名广告和已学习域名），
// 再在过滤结果上走标记法（CUE / DATERANGE-SCTE35）或结构法。
function filterAdsFromM3U8(m3u8Content, applyFilter, baseUrl) {
    if (!m3u8Content) return '';
    const lines = m3u8Content.split('\n');
    const afterHost = filterByHostRules(m3u8Content, lines, baseUrl, applyFilter);
    const linesAfter = afterHost.split('\n');
    // 有广告标记就走标记法，没有就走结构法（采集站插播广告不给 CUE 标记）
    const hasAdStart = linesAfter.some(line => isAdStartTag(line.trim()));
    if (!hasAdStart) {
        return finishFiltering(filterByStructure(afterHost, linesAfter, baseUrl, applyFilter), baseUrl);
    }
    if (!applyFilter) {
        recordAdFilterStats(afterHost, 0, false, 'cue', 0);
        return afterHost;
    }
    const kept = [];
    const adUris = [];
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
    for (let i = 0; i < linesAfter.length; i++) {
        const line = linesAfter[i];
        const trimmed = line.trim();
        // CUE-OUT-CONT 也是以 CUE-OUT 开头，一并算作广告区间内
        if (isAdStartTag(trimmed)) {
            inAd = true;
            continue;
        }
        if (isAdEndTag(trimmed)) {
            inAd = false;
            sawCueIn = true;
            pendingBreak = true;
            continue;
        }
        if (inAd) {
            if (trimmed.indexOf('#EXTINF') === 0) removed += 1;
            else if (trimmed && trimmed.charAt(0) !== '#') adUris.push(trimmed);
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
        recordAdFilterStats(afterHost, 0, false, 'cue', 0);
        return afterHost;
    }
    // 兜底：标记打错位置时会一口气删掉大半正片，超过三成就当标记不可信，原样放行。
    // 宁可让用户看广告，也不能把正片删没。
    const totalSegments = linesAfter.reduce((n, l) => (l.trim().indexOf('#EXTINF') === 0 ? n + 1 : n), 0);
    if (removed > 5 && removed > totalSegments * 0.3) {
        recordAdFilterStats(afterHost, 0, true, 'cue', 0);
        return afterHost;
    }
    // 广告分片的域名记入学习型黑名单（正片用过的域名不记）
    const keptUris = kept.map(l => l.trim()).filter(t => t && t.charAt(0) !== '#');
    rememberAdHosts(adUris, keptUris, baseUrl);
    recordAdFilterStats(afterHost, removed, false, 'cue', 0);
    return finishFiltering(kept.join('\n'), baseUrl);
}
