// 投屏模块：Chromecast（Google Cast 网页发送端）+ AirPlay（Safari 内建）
// 能力边界（如实说明，不做假按钮）：
// - Chromecast：走 Google Cast Sender SDK，把 m3u8/mp4 地址直接交给电视端播放，
//   用 Google 默认媒体接收器（CC1AD845），无需自建接收器。
//   仅桌面 Chrome/Edge 支持（Google 不给移动端浏览器提供 Cast Sender 能力）；
//   要求页面运行在 HTTPS；电视与电脑需在同一局域网。
// - AirPlay：Safari（macOS/iOS）内建，由 ArtPlayer 的 airplay 控件触发，无需额外代码。
// - DLNA：需要发局域网 UDP 广播（SSDP），浏览器环境做不到，不提供。
// - 部分采集源需要特定 Referer 才能播放，接收器直接拉流可能失败，这类源投不了属预期行为。
(function () {
    'use strict';
    const CAST_SENDER_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js';
    const DEFAULT_RECEIVER_APP_ID = 'CC1AD845';
    const CAST_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z"/></svg>';
    let sdkLoading = false;
    let sdkLoaded = false;
    let optionsSet = false;
    let sessionBound = false;
    let activeArt = null;

    function androidBridge() {
        return typeof getAndroidBridge === 'function' && !!getAndroidBridge();
    }

    function isSecure() {
        return location.protocol === 'https:' ||
            location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    }

    // 按钮可见性：桌面 Chrome/Edge + HTTPS。Safari 走 ArtPlayer 自带的 AirPlay 按钮。
    function buttonVisible() {
        if (androidBridge() || !isSecure()) return false;
        if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return false;
        return !!window.chrome;
    }

    function loadCastSdk() {
        if (sdkLoaded || sdkLoading) return;
        sdkLoading = true;
        window['__onGCastApiAvailable'] = function (available) {
            sdkLoaded = !!available;
            sdkLoading = false;
        };
        const script = document.createElement('script');
        script.src = CAST_SENDER_URL;
        script.async = true;
        script.onerror = function () { sdkLoading = false; };
        document.head.appendChild(script);
    }

    function contentTypeFor(url) {
        const type = typeof getVideoType === 'function' ? getVideoType(url) : '';
        if (type === 'mp4') return 'video/mp4';
        if (type === 'webm') return 'video/webm';
        return 'application/vnd.apple.mpegurl';
    }

    function castReady() {
        return sdkLoaded && window.cast && cast.framework && window.chrome && chrome.cast;
    }

    function setCastingUi(art, casting) {
        try {
            if (!art || !art.controls || typeof art.controls.update !== 'function') return;
            art.controls.update({
                name: 'cast',
                html: CAST_ICON,
                tooltip: casting ? '停止投屏' : '投屏'
            });
        } catch (e) { /* 控制栏更新失败不影响播放 */ }
    }

    function bindSessionEvents() {
        if (sessionBound || !castReady()) return;
        sessionBound = true;
        cast.framework.CastContext.getInstance().addEventListener(
            cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
            function (event) {
                if (event.sessionState === cast.framework.SessionState.SESSION_ENDED ||
                    event.sessionState === cast.framework.SessionState.NO_SESSION) {
                    setCastingUi(activeArt, false);
                }
            });
    }

    function startCast(art) {
        const context = cast.framework.CastContext.getInstance();
        if (!optionsSet) {
            context.setOptions({
                receiverApplicationId: DEFAULT_RECEIVER_APP_ID,
                autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
            });
            optionsSet = true;
        }
        bindSessionEvents();
        context.requestSession().then(function () {
            const session = context.getCurrentSession();
            if (!session) return;
            const url = (art && art.url) || (art && art.video && art.video.currentSrc) || '';
            if (!url) {
                if (art.notice) art.notice.show = '没有可投屏的视频地址';
                return;
            }
            const mediaInfo = new chrome.cast.media.MediaInfo(url, contentTypeFor(url));
            const request = new chrome.cast.media.LoadRequest(mediaInfo);
            // 从当前进度接着投
            request.currentTime = Math.max(0, (art.video && art.video.currentTime) || 0);
            session.loadMedia(request).then(function () {
                if (art.pause) art.pause();
                setCastingUi(art, true);
                if (art.notice) art.notice.show = '已投屏到电视，从 ' + Math.floor(request.currentTime / 60) + ' 分 ' + Math.floor(request.currentTime % 60) + ' 秒继续';
            }).catch(function (err) {
                console.warn('cast loadMedia failed', err);
                if (art.notice) art.notice.show = '投屏失败：该视频源可能限制了电视端直接拉流';
            });
        }).catch(function (err) {
            // 用户在设备选择框点了取消，不算错误
            if (err && (err.description === 'cancelled' || err.code === 'cancel')) return;
            console.warn('cast requestSession failed', err);
            if (art.notice) art.notice.show = '投屏失败：未找到可用的 Chromecast 设备';
        });
    }

    function toggle(art) {
        activeArt = art || activeArt;
        if (!castReady()) {
            loadCastSdk();
            if (art && art.notice) {
                art.notice.show = sdkLoading ? '正在初始化投屏，请稍候再点一次' : '当前浏览器不支持投屏（需 Chrome/Edge 且 HTTPS）';
            }
            return;
        }
        const context = cast.framework.CastContext.getInstance();
        const session = context.getCurrentSession();
        if (session) {
            session.endSession();
            setCastingUi(activeArt, false);
            if (activeArt && activeArt.notice) activeArt.notice.show = '已停止投屏';
            return;
        }
        startCast(activeArt);
    }

    window.PlayerCast = {
        buttonVisible: buttonVisible,
        init: loadCastSdk,
        toggle: toggle,
        icon: CAST_ICON
    };
})();
