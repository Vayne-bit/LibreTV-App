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

    // 取「原始」视频地址给投屏/诊断用。hls.js 走 MSE 后 video.currentSrc 是
    // blob: 内存地址（电视无法访问），真正的 m3u8 清单地址在 hls 实例上；
    // blob: 一律视为无效地址，逐级回退直到找到 http(s) 开头的真实地址。
    function currentSourceUrl(art) {
        if (!art) return '';
        const candidates = [
            art.hls && art.hls.url,
            art.flv && art.flv.url,
            art.url,
            art.video && art.video.currentSrc
        ];
        for (let i = 0; i < candidates.length; i++) {
            const u = candidates[i];
            if (typeof u === 'string' && /^https?:\/\//i.test(u)) return u;
        }
        return '';
    }

    // 控制栏按钮配置：Tauri 壳里出 DLNA 按钮，网页里出 Chromecast 按钮（桌面 Chrome/Edge）
    // click 里的 art 是 player_artplayer_handler.js 的全局变量（经典脚本共享全局词法作用域），
    // 点击时 initPlayer 已执行完毕，引用安全。
    function buttonConfig() {
        // 注意顺序：Tauri Android 壳也注入了 LibreTVAndroid 原生桥（全屏/亮度/音量控制），
        // isTauri 必须先判，否则安卓 APK 里的 DLNA 按钮会被下面的 androidBridge 误杀。
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
        // 非 Tauri 的老安卓 WebView 壳（DPlayer 版）：控制条空间有限，不显示网页投屏按钮
        if (androidBridge()) return null;
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

    // Tauri 命令失败时 reject 的值可能是字符串（Rust 侧 Err(String) 原样透传），
    // 也可能是 Error 对象；统一取可读文本，不再被 err.message 未定义掩盖真实原因。
    function errMsg(err) {
        if (err === null || err === undefined) return '未知错误';
        if (typeof err === 'string') return err;
        if (err.message) return String(err.message);
        try { return JSON.stringify(err); } catch (e) { return String(err); }
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

    // ---------- 投屏（Tauri 壳：DLNA + AirPlay） ----------

    // 待投屏状态：选择设备后使用
    let pendingUrl = null;
    let pendingReferer = null;
    let pendingPauseSelf = false;
    let pendingLocalPath = null;     // 非空表示投本地视频文件
    let pendingResolveReferer = null;

    // 从 http://ip:port/... 取主机（IP），用于让本地服务按设备网段选 LAN 地址
    function hostOf(url) {
        try {
            return new URL(url).hostname;
        } catch (e) {
            return (url || '').replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
        }
    }

    function toggleDlna(art) {
        activeArt = art || activeArt;
        if (!isTauri() || typeof tauriInvoke !== 'function') {
            notice(activeArt, '投屏仅限 App 内使用');
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
        const url = currentSourceUrl(activeArt);
        if (!url) {
            notice(activeArt, '当前没有可投屏的视频源');
            return;
        }
        chooseDeviceThenCast(url, currentReferer(), true, null);
    }

    // 同时搜索 DLNA 与 AirPlay 设备并合并（任一失败不影响另一个）
    async function searchAllCastDevices(timeoutMs) {
        const dl = tauriInvoke('search_dlna_devices', { timeoutMs: timeoutMs }).catch(function () { return []; });
        const ap = tauriInvoke('search_airplay_devices', { timeoutMs: timeoutMs }).catch(function () { return []; });
        const results = await Promise.all([dl, ap]);
        const merged = [];
        results.forEach(function (list) { if (Array.isArray(list)) merged.push.apply(merged, list); });
        return merged;
    }

    // 搜索设备 → 弹窗选择 → 按协议投屏。localPath 非空时表示先起本地文件服务再投。
    function chooseDeviceThenCast(url, referer, pauseSelf, localPath) {
        if (dlnaSearching) return;
        dlnaSearching = true;
        notice(activeArt, '正在搜索局域网内的电视/盒子...');
        searchAllCastDevices(3500).then(function (devices) {
            dlnaSearching = false;
            if (!devices || !devices.length) {
                notice(activeArt, noDeviceHint());
                return;
            }
            pendingUrl = url;
            pendingReferer = referer;
            pendingPauseSelf = pauseSelf;
            pendingLocalPath = localPath || null;
            showDeviceChooser(devices);
        }).catch(function (err) {
            dlnaSearching = false;
            console.warn('device search failed', err);
            notice(activeArt, '搜索设备失败：' + errMsg(err));
        });
    }

    // 搜不到设备时的提示按平台区分：Windows 端两大主因是防火墙拦应答
    // （首次弹窗点过「取消」会生成阻止规则）与网络被归为「公用网络」，
    // 只提示同一网络对 Windows 用户不够用。
    function noDeviceHint() {
        if (/Windows/i.test(navigator.userAgent)) {
            return '未发现可投屏设备：请确认电视与电脑在同一网络；Windows 请到防火墙「允许应用通过防火墙」勾选本应用（首次弹窗点过「取消」会被持续阻止），并把当前网络设为「专用网络」';
        }
        return '未发现可投屏设备，请确认电视与手机在同一网络';
    }

    function showDeviceChooser(devices) {
        removeDeviceChooser();
        const overlay = document.createElement('div');
        overlay.id = 'dlna-device-chooser';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
        const panel = document.createElement('div');
        panel.style.cssText = 'background:#1e1e1e;color:#eee;border-radius:12px;padding:20px;min-width:260px;max-width:85vw;max-height:70vh;overflow:auto;';
        panel.innerHTML = '<div style="font-size:15px;margin-bottom:12px;">选择投屏设备</div>';
        devices.forEach(function (device) {
            const protocol = device.protocol === 'airplay' ? 'AirPlay' : 'DLNA';
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = (device.name || device.control_url) + '  〔' + protocol + '〕';
            button.style.cssText = 'display:block;width:100%;text-align:left;padding:10px 12px;margin:4px 0;background:#2b2b2b;color:#eee;border:1px solid #3a3a3a;border-radius:8px;font-size:14px;cursor:pointer;word-break:break-all;';
            button.onmouseenter = function () { button.style.background = '#3a3a3a'; };
            button.onmouseleave = function () { button.style.background = '#2b2b2b'; };
            button.onclick = function () {
                removeDeviceChooser();
                onDeviceChosen(device);
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

    // 设备选定：本地视频先起服务，再统一路由投屏
    function onDeviceChosen(device) {
        if (pendingLocalPath) {
            const deviceIp = hostOf(device.control_url);
            tauriInvoke('start_local_file_server', { path: pendingLocalPath, preferredIp: deviceIp }).then(function (entry) {
                // 本机用回环地址播放，电视用 LAN 地址（按设备网段选，多网卡/VPN 下可达）
                if (activeArt && activeArt.switchUrl) {
                    try { activeArt.switchUrl(entry.loopback_url); } catch (e) { /* 不支持切换则忽略 */ }
                }
                castUrlToDevice(device, entry.url, null, false);
            }).catch(function (e) {
                notice(activeArt, '本地视频服务失败：' + errMsg(e));
            });
        } else {
            castUrlToDevice(device, pendingUrl, pendingReferer, pendingPauseSelf);
        }
    }

    function removeDeviceChooser() {
        const existing = document.getElementById('dlna-device-chooser');
        if (existing) existing.remove();
    }

    // 按协议把视频地址投到指定设备：DLNA 走 cast_to_device，AirPlay 走 cast_to_airplay
    function castUrlToDevice(device, url, referer, pauseSelf) {
        const art = activeArt;
        if (!url || !art) {
            notice(art, '未拿到可投屏的视频地址');
            return;
        }
        const isAirPlay = device.protocol === 'airplay';
        notice(art, '正在投屏到「' + (device.name || '设备') + '」(' + (isAirPlay ? 'AirPlay' : 'DLNA') + ')...');
        const onOk = function () {
            dlnaActiveControlUrl = device.control_url;
            if (pauseSelf && art.pause) art.pause();
            setCastingUi(art, true);
            setCastKeepAwake(true);
            let msg = isAirPlay ? '已投屏到电视（AirPlay）' : '已投屏到电视';
            if (/Windows/i.test(navigator.userAgent) && !isAirPlay) {
                msg += '；若电视一直加载不出，通常是防火墙拦了电视访问本机，请在防火墙「允许应用通过防火墙」中勾选本应用后重试';
            }
            notice(art, msg);
        };
        const onErr = function (err) {
            setCastKeepAwake(false);
            console.warn('cast failed', err);
            notice(art, '投屏失败：' + errMsg(err));
        };
        if (isAirPlay) {
            tauriInvoke('cast_to_airplay', { baseUrl: device.control_url, videoUrl: url })
                .then(onOk).catch(onErr);
        } else {
            // 广告过滤：投屏时电视自己拉流，浏览器侧的过滤对电视无效。
            // 把本次判定出的广告分片地址传过去，由代理侧按名单剔除。
            let adUris = [];
            try {
                if (typeof getRemovedSegmentUris === 'function') {
                    const list = getRemovedSegmentUris();
                    if (Array.isArray(list)) adUris = list;
                }
            } catch (e) { adUris = []; }
            tauriInvoke('cast_to_device', {
                controlUrl: device.control_url,
                url: url,
                title: (typeof currentVideoTitle === 'string' && currentVideoTitle) ? currentVideoTitle : 'LibreTV',
                position: (art.video && art.video.currentTime) || 0,
                referer: referer || null,
                adUris: adUris
            }).then(onOk).catch(onErr);
        }
    }

    // 本地视频播放：系统文件选择器 → 本机起 HTTP 服务 → 直接用回环地址在 App 内播放
    // （不在此投屏；投屏交给菜单里的「投屏到电视」，当前视频源已就绪即可直接投）
    async function pickAndPlayLocalVideo(art) {
        activeArt = art || activeArt;
        if (!isTauri() || typeof tauriInvoke !== 'function') {
            notice(activeArt, '本地视频仅限 App 内使用');
            return;
        }
        let path = null;
        try {
            path = await tauriInvoke('pick_local_video', {});
        } catch (e) {
            notice(activeArt, '文件选择失败：' + errMsg(e));
            return;
        }
        if (!path) return; // 用户取消
        notice(activeArt, '已选择本地文件，正在本机准备播放...');
        // 本机播放走回环地址；preferredIp 传 null 让服务自己选 LAN 地址（电视投屏时才需要）
        tauriInvoke('start_local_file_server', { path: path, preferredIp: null }).then(function (entry) {
            if (activeArt && activeArt.switchUrl) {
                try { activeArt.switchUrl(entry.loopback_url); } catch (e) { /* 不支持切换则忽略 */ }
            }
            notice(activeArt, '正在本机播放：' + (entry.name || path));
        }).catch(function (e) {
            notice(activeArt, '本地视频服务失败：' + errMsg(e));
        });
    }

    // VIP 解析播放：一个入口同时支持两种用法（都只在 App 内播放；投屏复用「投屏到电视」）
    //  · 粘贴 VIP 视频页面 URL → 用可配置解析接口取回可播地址 → 本机播放
    //  · 输入关键词 → 复用现有资源站聚合搜索列出结果 → 点选 → 取详情首集 → 本机播放
    function openResolvePlay(art) {
        activeArt = art || activeArt;
        if (!isTauri() || typeof tauriInvoke !== 'function') {
            notice(activeArt, '解析仅限 App 内使用');
            return;
        }
        removeResolveDialog();
        let savedApi = '';
        try { savedApi = localStorage.getItem('vipApiBase') || ''; } catch (e) {}
        if (!savedApi) savedApi = 'jx.xmflv.com';
        const overlay = document.createElement('div');
        overlay.id = 'vip-resolve-dialog';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML =
            '<div style="background:#1e1e1e;color:#eee;border-radius:12px;padding:18px;width:min(440px,92vw);max-height:88vh;overflow:auto;">' +
            '<div style="font-size:15px;margin-bottom:4px;">VIP 解析播放</div>' +
            '<div style="font-size:12px;opacity:.6;margin-bottom:10px;">粘贴 VIP 页面 URL，或输入片名关键词检索</div>' +
            '<input id="vip-input" style="width:100%;box-sizing:border-box;padding:9px;margin-bottom:8px;background:#2b2b2b;color:#eee;border:1px solid #3a3a3a;border-radius:8px;font-size:13px;" placeholder="https://... 或 片名关键词" />' +
            '<div id="vip-api-row" style="margin-bottom:12px;">' +
            '<div style="font-size:12px;opacity:.6;margin-bottom:4px;">解析接口（仅 URL 模式需要，可配置）</div>' +
            '<input id="vip-api-base" value="' + savedApi + '" style="width:100%;box-sizing:border-box;padding:8px;background:#2b2b2b;color:#eee;border:1px solid #3a3a3a;border-radius:8px;font-size:13px;" placeholder="jx.xmflv.com" />' +
            '</div>' +
            '<div style="display:flex;gap:8px;margin-bottom:10px;">' +
            '<button id="vip-resolve-go" style="flex:1;padding:9px;background:#2563eb;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;">播放</button>' +
            '<button id="vip-resolve-cancel" style="padding:9px;background:transparent;color:#999;border:none;font-size:13px;cursor:pointer;">取消</button>' +
            '</div>' +
            '<div id="vip-results" style="display:none;"></div>' +
            '</div>';
        overlay.onclick = function (event) { if (event.target === overlay) removeResolveDialog(); };
        document.body.appendChild(overlay);
        const goBtn = overlay.querySelector('#vip-resolve-go');
        const cancelBtn = overlay.querySelector('#vip-resolve-cancel');
        const input = overlay.querySelector('#vip-input');
        const apiInput = overlay.querySelector('#vip-api-base');
        const apiRow = overlay.querySelector('#vip-api-row');
        const resultsBox = overlay.querySelector('#vip-results');
        if (cancelBtn) cancelBtn.onclick = removeResolveDialog;
        if (input) setTimeout(function () { try { input.focus(); } catch (e) {} }, 50);
        if (goBtn) goBtn.onclick = function () {
            const q = (input && input.value || '').trim();
            if (!q) { notice(activeArt, '请输入 URL 或关键词'); return; }
            const isUrl = /^https?:\/\//i.test(q);
            if (isUrl) {
                // URL 模式：外部解析接口取回可播地址
                const apiBase = (apiInput && apiInput.value || '').trim() || savedApi;
                try { localStorage.setItem('vipApiBase', apiBase); } catch (e) {}
                removeResolveDialog();
                notice(activeArt, '正在解析「' + q + '」...');
                tauriInvoke('resolve_vip_url', { pageUrl: q, apiBase: apiBase }).then(function (res) {
                    if (!res || !res.url) { notice(activeArt, '解析未返回可播地址'); return; }
                    if (activeArt && activeArt.switchUrl) {
                        try { activeArt.switchUrl(res.url); } catch (e) {}
                    }
                    notice(activeArt, '解析成功，正在本机播放；需要投屏请点齿轮菜单「投屏到电视」');
                }).catch(function (e) {
                    notice(activeArt, '解析失败：' + errMsg(e));
                });
            } else {
                // 关键词模式：复用现有资源站聚合搜索，列表点选后取详情首集播放
                if (apiRow) apiRow.style.display = 'none';
                if (goBtn) { goBtn.disabled = true; goBtn.textContent = '搜索中...'; }
                vipSearchKeyword(q).then(function (list) {
                    if (goBtn) { goBtn.disabled = false; goBtn.textContent = '重新搜索'; }
                    if (!list || list.length === 0) {
                        resultsBox.style.display = 'block';
                        resultsBox.innerHTML = '<div style="font-size:13px;opacity:.7;padding:8px 2px;">未检索到结果，换个关键词试试</div>';
                        return;
                    }
                    vipRenderResults(resultsBox, list);
                }).catch(function (e) {
                    if (goBtn) { goBtn.disabled = false; goBtn.textContent = '重新搜索'; }
                    notice(activeArt, '检索失败：' + errMsg(e));
                });
            }
        };
    }

    // 复用后端 search_videos 在资源站中按关键词聚合检索（与首页搜索同源，不重造轮子）
    async function vipSearchKeyword(keyword) {
        const sources = Object.keys(API_SITES || {}).filter(function (k) {
            if (k === 'testSource') return false;
            return !(API_SITES[k] && API_SITES[k].adult);
        });
        const tasks = sources.map(function (src) {
            return tauriInvoke('search_videos', { query: keyword, sourceId: src, customApiUrl: null })
                .then(function (raw) {
                    let data;
                    try { data = JSON.parse(raw); } catch (e) { return []; }
                    const list = (data && Array.isArray(data.list)) ? data.list : [];
                    list.forEach(function (it) {
                        it.source_code = src;
                        it.source_name = (API_SITES[src] && API_SITES[src].name) || src;
                    });
                    return list;
                })
                .catch(function () { return []; });
        });
        const all = await Promise.all(tasks);
        const merged = [];
        const seen = {};
        all.forEach(function (arr) {
            arr.forEach(function (it) {
                const key = (it.vod_name || '') + '|' + (it.vod_id || '');
                if (seen[key]) return;
                seen[key] = true;
                merged.push(it);
            });
        });
        return merged.slice(0, 40);
    }

    // 把检索结果渲染成可点选列表
    function vipRenderResults(box, list) {
        box.style.display = 'block';
        box.innerHTML = '<div style="font-size:12px;opacity:.6;margin-bottom:8px;">共 ' + list.length + ' 条，点击即播放</div>';
        list.forEach(function (it) {
            const card = document.createElement('div');
            const safeName = (typeof escapeHtml === 'function' ? escapeHtml(it.vod_name || '未命名') : (it.vod_name || '未命名'));
            const safeSrc = (typeof escapeHtml === 'function' ? escapeHtml(it.source_name || '') : (it.source_name || ''));
            const remarks = it.vod_remarks ? (typeof escapeHtml === 'function' ? escapeHtml(String(it.vod_remarks)) : String(it.vod_remarks)) : '';
            card.style.cssText = 'display:flex;gap:10px;align-items:center;padding:8px;margin:4px 0;background:#2b2b2b;border:1px solid #3a3a3a;border-radius:8px;cursor:pointer;';
            const pic = (it.vod_pic && /^https?:\/\//.test(it.vod_pic))
                ? '<img src="' + it.vod_pic + '" style="width:46px;height:62px;object-fit:cover;border-radius:4px;flex:none;" onerror="this.style.display=\'none\'" />'
                : '<div style="width:46px;height:62px;background:#333;border-radius:4px;flex:none;"></div>';
            card.innerHTML = pic +
                '<div style="min-width:0;flex:1;">' +
                '<div style="font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + safeName + '</div>' +
                '<div style="font-size:11px;opacity:.6;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + safeSrc + (remarks ? ' · ' + remarks : '') + '</div>' +
                '</div>';
            card.onclick = function () {
                removeResolveDialog();
                vipPlayResult(it);
            };
            box.appendChild(card);
        });
    }

    // 取某条结果的详情，解析出首个可播地址并播放（JSON 源走 videolist；ffzy/heimuer 走 HTML 抓取）
    function vipPlayResult(item) {
        const id = item.vod_id;
        const src = item.source_code;
        if (!id) { notice(activeArt, '该结果缺少视频 ID，无法播放'); return; }
        notice(activeArt, '正在获取「' + (item.vod_name || '') + '」播放地址...');
        vipFetchDetail(src, String(id)).then(function (episodes) {
            const url = (episodes || []).find(function (u) { return /^https?:\/\//.test(u); });
            if (!url) { notice(activeArt, '未解析到可播地址'); return; }
            if (activeArt && activeArt.switchUrl) {
                try { activeArt.switchUrl(url); } catch (e) {}
            }
            notice(activeArt, '正在本机播放；需要投屏请点齿轮菜单「投屏到电视」');
        }).catch(function (e) {
            notice(activeArt, '获取播放地址失败：' + errMsg(e));
        });
    }

    // 取详情：JSON 源走 videolist 解析 vod_play_url；ffzy/heimuer 走 HTML 抓取 m3u8
    async function vipFetchDetail(src, id) {
        const isHtml = (src === 'ffzy' || src === 'heimuer');
        let url;
        if (isHtml) {
            const base = (API_SITES[src] && API_SITES[src].detail) || (API_SITES[src] && API_SITES[src].api);
            url = base + '/index.php/vod/detail/id/' + id + '.html';
        } else {
            const base = (API_SITES[src] && API_SITES[src].api) || '';
            url = base + (API_CONFIG.detail && API_CONFIG.detail.path || '/api.php/provide/vod/?ac=videolist&ids=') + id;
        }
        const opts = {
            url: url,
            method: 'GET',
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
            timeout_secs: 15,
            response_as_text: true
        };
        const resp = await tauriInvoke('make_http_request', { options: opts });
        if (!resp || !(resp.status >= 200 && resp.status < 300)) {
            throw new Error('详情请求失败：' + (resp && resp.status));
        }
        const body = resp.body || '';
        if (isHtml) {
            let matches = [];
            if (src === 'ffzy') matches = body.match(/\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g) || [];
            if (matches.length === 0) matches = body.match(/\$(https?:\/\/[^"'\s]+?\.m3u8)/g) || [];
            const uniq = [];
            const set = {};
            matches.forEach(function (m) {
                let link = m.substring(1);
                const p = link.indexOf('(');
                if (p > 0) link = link.substring(0, p);
                if (!set[link]) { set[link] = true; uniq.push(link); }
            });
            return uniq;
        }
        // JSON：vod_play_url -> $$$ 分线路 -> # 分集 -> $ 取第二段
        let data;
        try { data = JSON.parse(body); } catch (e) { return []; }
        const detail = (data && data.list && data.list[0]) || {};
        const play = detail.vod_play_url || '';
        if (!play) return [];
        const firstSource = play.split('$$$')[0] || '';
        return firstSource.split('#').map(function (ep) {
            const parts = ep.split('$');
            return parts.length > 1 ? parts[1] : '';
        }).filter(function (u) { return u && /^https?:\/\//.test(u); });
    }

    function removeResolveDialog() {
        const existing = document.getElementById('vip-resolve-dialog');
        if (existing) existing.remove();
    }

    // 投屏期间保活：本地代理在 App 进程里，系统休眠冻结网络会导致电视端卡断
    function setCastKeepAwake(enabled) {
        try {
            const bridge = typeof getAndroidBridge === 'function' ? getAndroidBridge() : null;
            if (bridge && typeof bridge.keepAwake === 'function') bridge.keepAwake(!!enabled);
        } catch (e) { /* 非安卓环境忽略 */ }
    }

    function stopDlna(deviceControlUrl) {
        if (!isTauri() || typeof tauriInvoke !== 'function') return;
        setCastKeepAwake(false);
        tauriInvoke('stop_dlna_cast', { controlUrl: deviceControlUrl }).catch(() => { /* ignore */ });
    }

    // ---------- 投屏诊断 ----------

    // 一键诊断：网卡/SSDP 搜索/设备指令应答/视频源拉流测试全部跑一遍，
    // 报告展示成弹窗，一键复制全文发给开发者，省去来回猜。
    async function runDiagnostics(art) {
        activeArt = art || activeArt;
        if (!isTauri() || typeof tauriInvoke !== 'function') {
            notice(activeArt, '诊断仅限 App 内使用');
            return;
        }
        const url = currentSourceUrl(activeArt);
        notice(activeArt, '正在诊断，约需 10 秒...');
        // 版本号取 Tauri 内置 app 插件的 version 命令（version_data.js 未被页面加载）
        let appVersion = '';
        try { appVersion = await tauriInvoke('plugin:app|version') || ''; } catch (e) { /* 退回 APP_VERSION */ }
        tauriInvoke('dlna_diagnostics', { testUrl: url, referer: currentReferer() }).then(rustReport => {
            showDiagnosticsDialog(buildDiagnosticsReport(rustReport, appVersion));
        }).catch(err => {
            console.warn('DLNA diagnostics failed', err);
            notice(activeArt, '诊断失败：' + errMsg(err));
        });
    }

    function buildDiagnosticsReport(rustReport, appVersion) {
        const version = appVersion ||
            (typeof window.APP_VERSION !== 'undefined' && window.APP_VERSION) || '未知';
        return '=== LibreTV 投屏环境诊断 ===\n' +
            'App版本: ' + version + '\n' +
            '平台: ' + navigator.userAgent + '\n' +
            '时间: ' + new Date().toLocaleString() + '\n\n' +
            (rustReport || '');
    }

    function showDiagnosticsDialog(text) {
        removeDiagnosticsDialog();
        const overlay = document.createElement('div');
        overlay.id = 'dlna-diagnostics-dialog';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:100001;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
        const panel = document.createElement('div');
        panel.style.cssText = 'background:#1e1e1e;color:#eee;border-radius:12px;padding:16px;width:min(680px,92vw);height:min(560px,80vh);display:flex;flex-direction:column;gap:10px;';
        const title = document.createElement('div');
        title.textContent = '投屏诊断报告';
        title.style.cssText = 'font-size:15px;font-weight:bold;flex:none;';
        const pre = document.createElement('pre');
        pre.textContent = text;
        pre.style.cssText = 'margin:0;padding:10px;background:#111;border:1px solid #3a3a3a;border-radius:8px;overflow:auto;flex:1;font-family:monospace;font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;color:#ddd;user-select:text;';
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:8px;flex:none;';
        const copyBtn = document.createElement('button');
        copyBtn.type = 'button';
        copyBtn.textContent = '复制报告';
        copyBtn.style.cssText = 'flex:1;padding:10px;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer;';
        copyBtn.onclick = function () {
            const done = function () {
                copyBtn.textContent = '已复制';
                setTimeout(function () { copyBtn.textContent = '复制报告'; }, 1500);
            };
            if (navigator.clipboard && navigator.clipboard.writeText) {
                navigator.clipboard.writeText(text).then(done).catch(function () { fallbackCopy(text); done(); });
            } else {
                fallbackCopy(text);
                done();
            }
        };
        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = '关闭';
        closeBtn.style.cssText = 'flex:1;padding:10px;background:#2b2b2b;color:#bbb;border:none;border-radius:8px;font-size:14px;cursor:pointer;';
        closeBtn.onclick = removeDiagnosticsDialog;
        btnRow.appendChild(copyBtn);
        btnRow.appendChild(closeBtn);
        panel.appendChild(title);
        panel.appendChild(pre);
        panel.appendChild(btnRow);
        overlay.appendChild(panel);
        overlay.onclick = function (event) {
            if (event.target === overlay) removeDiagnosticsDialog();
        };
        document.body.appendChild(overlay);
    }

    // 剪贴板 API 不可用时的兜底（老 WebView / 非安全上下文）
    function fallbackCopy(text) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        try { document.execCommand('copy'); } catch (e) { /* ignore */ }
        ta.remove();
    }

    function removeDiagnosticsDialog() {
        const existing = document.getElementById('dlna-diagnostics-dialog');
        if (existing) existing.remove();
    }

    window.PlayerCast = {
        buttonConfig: buttonConfig,
        init: loadCastSdk,
        toggle: toggle,
        toggleDlna: toggleDlna,
        pickAndPlayLocalVideo: pickAndPlayLocalVideo,
        openResolvePlay: openResolvePlay,
        stopDlna: stopDlna,
        runDiagnostics: runDiagnostics,
        icon: CAST_ICON,
        dlnaIcon: DLNA_ICON
    };
})();
