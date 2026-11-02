// 投屏模块：DLNA（Tauri 壳，Android/Windows）+ Chromecast（Google Cast 网页发送端）+ AirPlay（Safari 内建）
// 能力边界（如实说明，不做假按钮）：
// - DLNA：仅在 Tauri 壳里可用（调用 Rust 层 SSDP 搜索 + AVTransport 控制），
//   覆盖 95%+ 国产电视/盒子；源站需要 Referer/UA/Cookie 时由 Rust 本地代理中转，
//   防盗链源也能投。
// - Chromecast：走 Google Cast Sender SDK，把 m3u8/mp4 地址直接交给电视端播放，
//   仅桌面 Chrome/Edge 支持（Google 不给移动端浏览器提供 Cast Sender 能力）；
//   要求页面运行在 HTTPS；电视与电脑需在同一局域网。
// - AirPlay：Safari（macOS/iOS）内建，由 ArtPlayer 的 airplay 控件触发，无需额外代码。
// - 部分采集源需要特定 Referer 才能播放：DLNA 走本地代理可解决；
//   Chromecast 接收器直接拉流可能失败，这类源在网页端投不了属预期行为。
(function () {
    'use strict';
    const CAST_SENDER_URL = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js';
    const DEFAULT_RECEIVER_APP_ID = 'CC1AD845';
    const CAST_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M21 3H3c-1.1 0-2 .9-2 2v3h2V5h18v14h-7v2h7c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zM1 18v3h3c0-1.66-1.34-3-3-3zm0-4v2c2.76 0 5 2.24 5 5h2c0-3.87-3.13-7-7-7zm0-4v2c4.97 0 9 4.03 9 9h2c0-6.08-4.93-11-11-11z"/></svg>';
    const DLNA_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M17 1H7c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-2-2-2zm0 18H7V5h10v14zM8.5 21h7v-1h-7v1zM12 8.5c-2.9 0-5.4 1.6-6.7 4l1.7 1c1-2 3-3.3 5-3.3s4 1.3 5 3.3l1.7-1c-1.3-2.4-3.8-4-6.7-4zm0 4c-1.4 0-2.7.8-3.4 2l1.7 1c.4-.6 1-1 1.7-1s1.3.4 1.7 1l1.7-1c-.7-1.2-2-2-3.4-2z"/></svg>';
    let sdkLoading = false;
    let sdkLoaded = false;
    let optionsSet = false;
    let sessionBound = false;
    let activeArt = null;
    let dlnaSearching = false;
    let dlnaActiveControlUrl = null;

    function androidBridge() {
        return typeof getAndroidBridge === 'function' && !!getAndroidBridge();
    }

    function isSecure() {
        return location.protocol === 'https:' ||
            location.hostname === 'localhost' || location.hostname === '127.0.0.1';
    }

    function isTauri() {
        return typeof isTauriApp === 'function' && isTauriApp();
    }

    // 当前视频源的 Referer（播放页 URL 上带着 referrer 参数，透传给源站用）
    function currentReferer() {
        try {
            return new URLSearchParams(location.search).get('referrer') || '';
        } catch (e) {
            return '';
        }
    }

    // 控制栏按钮配置：Tauri 壳里出 DLNA 按钮，网页里出 Chromecast 按钮（桌面 Chrome/Edge）
    // click 里的 art 是 player_artplayer_handler.js 的全局变量（经典脚本共享全局词法作用域），
    // 点击时 initPlayer 已执行完毕，引用安全。
    function buttonConfig() {
        if (androidBridge()) return null;
        if (isTauri()) {
            return {
                name: 'cast',
                position: 'left',
                index: 14,
                html: DLNA_ICON,
                tooltip: 'DLNA 投屏',
                click: function () { toggleDlna(art); }
            };
        }
        if (!isSecure()) return null;
        if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return null;
        if (!window.chrome) return null;
        return {
            name: 'cast',
            position: 'left',
            index: 14,
            html: CAST_ICON,
            tooltip: '投屏',
            click: function () { toggle(art); }
        };
    }

    function loadCastSdk() {
        if (sdkLoaded || sdkLoading || isTauri()) return;
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
            const config = buttonConfig();
            if (!config) return;
            art.controls.update({
                name: 'cast',
                html: config.html,
                tooltip: casting ? '停止投屏' : config.tooltip
            });
        } catch (e) { /* 控制栏更新失败不影响播放 */ }
    }

    function notice(art, text) {
        try {
            if (art && art.notice) art.notice.show = text;
        } catch (e) { /* ignore */ }
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
                notice(art, '没有可投屏的视频地址');
                return;
            }
            const mediaInfo = new chrome.cast.media.MediaInfo(url, contentTypeFor(url));
            const request = new chrome.cast.media.LoadRequest(mediaInfo);
            // 从当前进度接着投
            request.currentTime = Math.max(0, (art.video && art.video.currentTime) || 0);
            session.loadMedia(request).then(function () {
                if (art.pause) art.pause();
                setCastingUi(art, true);
                notice(art, '已投屏到电视，本机暂停播放');
            }).catch(function (err) {
                console.warn('cast loadMedia failed', err);
                notice(art, '投屏失败：该视频源可能限制了电视端直接拉流');
            });
        }).catch(function (err) {
            // 用户在设备选择框点了取消，不算错误
            if (err && (err.description === 'cancelled' || err.code === 'cancel')) return;
            console.warn('cast requestSession failed', err);
            notice(art, '投屏失败：未找到可用的 Chromecast 设备');
        });
    }

    function toggle(art) {
        activeArt = art || activeArt;
        if (!castReady()) {
            loadCastSdk();
            notice(activeArt, sdkLoading ? '正在初始化投屏，请稍候再点一次' : '当前浏览器不支持投屏（需 Chrome/Edge 且 HTTPS）');
            return;
        }
        const context = cast.framework.CastContext.getInstance();
        const session = context.getCurrentSession();
        if (session) {
            session.endSession();
            setCastingUi(activeArt, false);
            notice(activeArt, '已停止投屏');
            return;
        }
        startCast(activeArt);
    }

    // ---------- DLNA（Tauri 壳） ----------

    function toggleDlna(art) {
        activeArt = art || activeArt;
        if (!isTauri() || typeof tauriInvoke !== 'function') {
            notice(activeArt, 'DLNA 投屏仅限 App 内使用');
            return;
        }
        // 已在投屏：再次点击即停止
        if (dlnaActiveControlUrl) {
            stopDlna(dlnaActiveControlUrl);
            dlnaActiveControlUrl = null;
            setCastingUi(activeArt, false);
            notice(activeArt, '已停止投屏');
            return;
        }
        if (dlnaSearching) return;
        dlnaSearching = true;
        notice(activeArt, '正在搜索局域网内的电视/盒子...');
        tauriInvoke('search_dlna_devices', { timeoutMs: 3500 }).then(devices => {
            dlnaSearching = false;
            if (!devices || !devices.length) {
                notice(activeArt, '未发现可投屏设备，请确认电视与手机在同一网络');
                return;
            }
            showDeviceChooser(devices);
        }).catch(err => {
            dlnaSearching = false;
            console.warn('DLNA search failed', err);
            notice(activeArt, '搜索设备失败：' + (err && err.message ? err.message : '未知错误'));
        });
    }

    function showDeviceChooser(devices) {
        removeDeviceChooser();
        const overlay = document.createElement('div');
        overlay.id = 'dlna-device-chooser';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
        const panel = document.createElement('div');
        panel.style.cssText = 'background:#1e1e1e;color:#eee;border-radius:12px;padding:20px;min-width:260px;max-width:85vw;max-height:70vh;overflow:auto;';
        panel.innerHTML = '<div style="font-size:15px;margin-bottom:12px;">选择投屏设备</div>';
        devices.forEach(device => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = device.name || device.control_url;
            button.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 12px;margin:4px 0;background:#2b2b2b;color:#eee;border:1px solid #3a3a3a;border-radius:8px;font-size:14px;cursor:pointer;word-break:break-all;';
            button.onmouseenter = function () { button.style.background = '#3a3a3a'; };
            button.onmouseleave = function () { button.style.background = '#2b2b2b'; };
            button.onclick = function () {
                removeDeviceChooser();
                castToDlnaDevice(device);
            };
            panel.appendChild(button);
        });
        const cancel = document.createElement('button');
        cancel.type = 'button';
        cancel.textContent = '取消';
        cancel.style.cssText = 'display:block;width:100%;padding:8px;margin-top:8px;background:transparent;color:#999;border:none;font-size:13px;cursor:pointer;';
        cancel.onclick = removeDeviceChooser;
        panel.appendChild(cancel);
        overlay.appendChild(panel);
        overlay.onclick = function (event) {
            if (event.target === overlay) removeDeviceChooser();
        };
        document.body.appendChild(overlay);
    }

    function removeDeviceChooser() {
        const existing = document.getElementById('dlna-device-chooser');
        if (existing) existing.remove();
    }

    function castToDlnaDevice(device) {
        const art = activeArt;
        const url = (art && art.url) || (art && art.video && art.video.currentSrc) || '';
        if (!url || !art) return;
        notice(art, '正在投屏到「' + (device.name || '设备') + '」...');
        tauriInvoke('cast_to_device', {
            controlUrl: device.control_url,
            url: url,
            title: (typeof currentVideoTitle === 'string' && currentVideoTitle) ? currentVideoTitle : 'LibreTV',
            position: (art.video && art.video.currentTime) || 0,
            referer: currentReferer()
        }).then(playbackUrl => {
            dlnaActiveControlUrl = device.control_url;
            if (art.pause) art.pause();
            setCastingUi(art, true);
            // 防盗链源走本地代理时，提示电视端实际播放的地址，便于排查
            const viaProxy = playbackUrl && playbackUrl.indexOf(location.hostname) === -1 &&
                /http:\/\/\d+\.\d+\.\d+\.\d+:\d+\//.test(playbackUrl);
            notice(art, viaProxy ? '已投屏（经本机代理转发，防盗链源已处理）' : '已投屏到电视');
        }).catch(err => {
            console.warn('DLNA cast failed', err);
            notice(art, '投屏失败：' + (err && err.message ? err.message : '设备拒绝了指令'));
        });
    }

    function stopDlna(deviceControlUrl) {
        if (!isTauri() || typeof tauriInvoke !== 'function') return;
        tauriInvoke('stop_dlna_cast', { controlUrl: deviceControlUrl }).catch(() => { /* ignore */ });
    }

    window.PlayerCast = {
        buttonConfig: buttonConfig,
        init: loadCastSdk,
        toggle: toggle,
        toggleDlna: toggleDlna,
        stopDlna: stopDlna,
        icon: CAST_ICON,
        dlnaIcon: DLNA_ICON
    };
})();
