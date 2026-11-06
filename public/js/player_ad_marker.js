// ============ 人工标记广告片段 ============
// 自动去广告规则（结构法/主机特征法/学习型黑名单）覆盖不了的场景：
// 切片广告与正片同 CDN、无断点标记、无路径特征——机器认不出来，人一眼就能认出来。
// 交互：暂停播放 → 长按画面（600ms）→ 弹出标记面板。
// 面板里程序会先尝试自动识别广告块（结构特征齐备时），直接给出起止时间；
// 识别不出来才退回手动标起点+终点。
// 标记按「剧名 + 集号」持久化到 localStorage，
// 播放中 timeupdate 命中区间就 seek 到终点并提示。
// 注意：这里记录的是「播放时间轴」位置，与 m3u8 过滤改动清单互不干扰。
(function () {
    'use strict';

    const STORE_KEY = 'manualAdSegments';
    const LONG_PRESS_MS = 600;
    const MOVE_TOLERANCE_PX = 12;
    const MIN_SEGMENT_SEC = 1; // 小于 1 秒的标记大概率是误触

    let art = null;
    let pendingStart = null; // 本次会话里待配对的起点（不持久化）
    let cachedKey = null;
    let cachedSegments = [];
    let pressTimer = null;
    let pressStartX = 0;
    let pressStartY = 0;
    let suppressClick = false;
    let dialogEl = null;
    let dialogTimeEl = null;
    let dialogListEl = null;
    let dialogEndBtn = null;
    let detectedAd = null; // 自动识别出的广告块（面板打开时算一次）

    // ---------- 存取 ----------

    function loadMap() {
        try {
            const parsed = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function persistMap(map) {
        try {
            localStorage.setItem(STORE_KEY, JSON.stringify(map));
        } catch (e) { /* 存储满/隐私模式：标记只在本次会话生效 */ }
    }

    // 标记的归属键：剧名 + 集号。
    // 用「剧-集」而不是视频源地址（origin+pathname）：同一集换线路、换 CDN、
    // 换 token 后地址都会变，按地址存等于每次都要重标一遍。
    // 片头跳过（readIntroSkip）用的就是这个思路。
    function sourceKey() {
        const title = (typeof currentVideoTitle === 'string' && currentVideoTitle) || '';
        const index = (typeof currentEpisodeIndex === 'number' && isFinite(currentEpisodeIndex))
            ? currentEpisodeIndex : 0;
        if (!title) return '';
        return title + '|' + index;
    }

    function segmentsFor(key) {
        if (!key) return [];
        if (key !== cachedKey) {
            cachedKey = key;
            cachedSegments = loadMap()[key] || [];
        }
        return cachedSegments;
    }

    function saveSegments(key, segs) {
        const map = loadMap();
        if (segs.length) {
            map[key] = segs;
        } else {
            delete map[key];
        }
        persistMap(map);
        cachedKey = key;
        cachedSegments = segs;
    }

    // ---------- 工具 ----------

    function fmt(t) {
        // 复用 player_utils.formatTime（player.html 里先于本文件加载）：
        // 旧实现超一小时会显示 75:00，formatTime 显示 1:15:00
        return formatTime(t);
    }

    function toast(msg) {
        if (art && art.notice) art.notice.show = msg;
    }

    // ---------- 自动识别广告块 ----------

    // 当前播放清单的地址（hls 实例的清单地址优先）。取「被删分片名单」时必须
    // 按这个地址去拿：同页可能有其它过滤在跑（如后台下载其它集），
    // 全局「最近一次」的名单可能是别的清单的。
    function currentPlaylistUrl() {
        if (!art) return '';
        return (art.hls && art.hls.url) || art.url || '';
    }

    // 当前播放列表的原始结构（过滤前的清单，由 player_artplayer_handler.js 留存）
    function currentPlaylist() {
        const u = currentPlaylistUrl();
        if (!u || typeof getRawPlaylist !== 'function') return null;
        try {
            return getRawPlaylist(u);
        } catch (e) {
            return null;
        }
    }

    // 尝试自动框出当前播放位置所在的广告块。
    // 识别不出来返回 null，调用方退回手动标记起点+终点。
    //
    // 返回的是「原始清单时间轴」上的区间（与存储格式一致）：
    // 自动过滤每次删掉的分片可能不同，播放时间轴的偏移每次都变，
    // 只有存原始时间轴、播放时再换算，才能保证每次都对得上。
    function detectAdBlock() {
        if (typeof AdBlockLocator === 'undefined') return null;
        const playlist = currentPlaylist();
        if (!playlist) return null;
        const t = art && art.currentTime ? art.currentTime : 0;
        const removed = (typeof getRemovedSegmentIds === 'function') ? getRemovedSegmentIds(currentPlaylistUrl()) : null;
        try {
            // 播放时间 → 原始时间：把已删除分片的时长加回去
            const originalTime = playbackToOriginalTime(playlist, t, removed);
            const hit = AdBlockLocator.candidateAt(playlist, originalTime);
            if (!hit) return null;
            // 候选块的分片已经被自动规则删掉了 → 这一段根本不会播，用户也看不到，
            // 不该作为可标记目标。
            if (removed && removed.size) {
                const stillThere = playlist.segments.some(seg =>
                    seg.start >= hit.start && seg.start < hit.end && !removed.has(seg.id));
                if (!stillThere) return null;
            }
            return {
                start: hit.start,
                end: hit.end,
                duration: hit.duration,
                segmentCount: hit.segmentCount,
                prefix: hit.prefix
            };
        } catch (e) {
            return null;
        }
    }

    // 播放时间轴 → 原始清单时间轴
    //
    // 两个时间轴的差值 = 该时刻之前「已被删除的分片」的时长总和。
    // 被删的分片在播放时间轴上不存在，那一段时长整体消失。
    //
    // removedIds 用「URI + 出现序号」标识：同一个广告文件名可能在片头片尾各出现一次，
    // 只看 URI 会把片尾的广告误当成已删除，偏移就多算了一段。
    function playbackToOriginalTime(playlist, playbackTime, removed) {
        if (!playlist || !removed || !removed.size) return playbackTime;
        let removedBefore = 0;
        for (let i = 0; i < playlist.segments.length; i++) {
            const seg = playlist.segments[i];
            if (seg.start >= playlist.segments[playlist.segments.length - 1].start) break;
            // 该分片在播放时间轴上的起点 = 原始起点 - 之前被删的总时长
            const playStart = seg.start - removedBefore;
            if (playStart >= playbackTime) break;
            if (removed.has(seg.id)) removedBefore += seg.duration;
        }
        return playbackTime + removedBefore;
    }

    // ---------- 长按识别 ----------

    function inVideoArea(target) {
        if (!target || target.nodeType !== 1 || !art) return false;
        if (target === art.video) return true;
        // 控件、设置面板、进度条上的按住不算长按画面
        if (target.closest('.art-control, .art-settings, .art-layer, .art-bottom, .art-left, .art-right, .art-mask, .art-progress, .art-info')) return false;
        return !!target.closest('.art-video-player');
    }

    function clearPressTimer() {
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
        }
    }

    function onPressStart(e) {
        if (!art || !inVideoArea(e.target)) return;
        if (e.touches && e.touches.length !== 1) return;
        const t = e.touches ? e.touches[0] : e;
        pressStartX = t.clientX || 0;
        pressStartY = t.clientY || 0;
        clearPressTimer();
        pressTimer = setTimeout(function () {
            pressTimer = null;
            suppressClick = true; // 长按结束后拦截随之而来的 click（避免误触暂停/控制条）
            setTimeout(function () { suppressClick = false; }, 500);
            openDialog();
        }, LONG_PRESS_MS);
    }

    function onPressMove(e) {
        if (!pressTimer) return;
        const t = e.touches ? e.touches[0] : e;
        // 移动超过容差当作拖动/滑动，取消长按
        if (Math.abs((t.clientX || 0) - pressStartX) > MOVE_TOLERANCE_PX ||
            Math.abs((t.clientY || 0) - pressStartY) > MOVE_TOLERANCE_PX) {
            clearPressTimer();
        }
    }

    function onPressEnd() {
        clearPressTimer();
    }

    function onClickCapture(e) {
        if (suppressClick) {
            e.stopImmediatePropagation();
            e.preventDefault();
        }
    }

    // ---------- 面板 ----------

    function buildDialog() {
        const mask = document.createElement('div');
        mask.style.cssText = 'position:absolute;inset:0;z-index:120;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.55);';
        const panel = document.createElement('div');
        panel.style.cssText = 'min-width:260px;max-width:82%;max-height:80%;overflow:auto;background:#1e1e26;border-radius:12px;padding:16px 18px;color:#eee;font-size:14px;line-height:1.6;box-shadow:0 8px 32px rgba(0,0,0,.5);';
        panel.innerHTML = '<div style="font-weight:600;font-size:15px;margin-bottom:6px;">标记广告片段</div>' +
            '<div style="opacity:.65;font-size:12px;margin-bottom:10px;">当前位置：<span data-time>--:--</span>　·　保存后播放到该区间会自动跳过，仅对当前这一集生效</div>' +
            // 自动识别区：程序按结构特征框出整块广告时显示，用户点一下就存
            '<div data-auto style="display:none;margin-bottom:10px;padding:10px 12px;border-radius:10px;background:rgba(251,114,153,.12);border:1px solid rgba(251,114,153,.35);">' +
            '<div style="font-size:13px;margin-bottom:8px;">已自动识别出这一段广告：<b data-auto-range>--</b>（<span data-auto-dur></span>）</div>' +
            '<button data-act="auto" style="width:100%;padding:9px 10px;border:none;border-radius:8px;background:#fb7299;color:#fff;cursor:pointer;">标记这一整段广告</button>' +
            '</div>' +
            // 手动区：自动识别失败时才显示
            '<div data-manual style="display:none;">' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">' +
            '<button data-act="start" style="flex:1;min-width:110px;padding:8px 10px;border:none;border-radius:8px;background:#fb7299;color:#fff;cursor:pointer;">标记为广告起点</button>' +
            '<button data-act="end" style="flex:1;min-width:110px;padding:8px 10px;border:none;border-radius:8px;background:#3a3a46;color:#fff;cursor:pointer;">标记终点并保存</button>' +
            '<button data-act="close" style="padding:8px 12px;border:none;border-radius:8px;background:#2a2a33;color:#bbb;cursor:pointer;">关闭</button>' +
            '</div></div>' +
            '<div data-list style="font-size:13px;"></div>';
        mask.appendChild(panel);

        mask.addEventListener('click', function (e) {
            const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
            if (act === 'start') {
                markStart();
            } else if (act === 'end') {
                markEnd();
            } else if (act === 'auto') {
                markDetected();
            } else if (act === 'close') {
                closeDialog();
            } else if (e.target.hasAttribute && e.target.hasAttribute('data-del')) {
                removeSegment(parseInt(e.target.getAttribute('data-del'), 10));
            } else if (e.target === mask) {
                closeDialog();
            }
        });
        return mask;
    }

    function renderDialog() {
        if (!dialogEl || !art) return;
        const t = art.currentTime || 0;
        if (dialogTimeEl) dialogTimeEl.textContent = fmt(t);
        const segs = segmentsFor(sourceKey());
        if (dialogEndBtn) {
            dialogEndBtn.disabled = pendingStart === null;
            dialogEndBtn.style.opacity = pendingStart === null ? '.45' : '1';
        }
        // 自动识别结果只在面板打开时算一次：识别到就把「一键标记」摆出来，
        // 没识别到就退回手动起止（广告与正片同 CDN 时机器确实看不出来）。
        const autoBox = dialogEl.querySelector('[data-auto]');
        const manualBox = dialogEl.querySelector('[data-manual]');
        if (autoBox && manualBox) {
            if (detectedAd) {
                autoBox.style.display = 'block';
                manualBox.style.display = 'none';
                const rangeEl = dialogEl.querySelector('[data-auto-range]');
                const durEl = dialogEl.querySelector('[data-auto-dur]');
                if (rangeEl) rangeEl.textContent = fmt(detectedAd.start) + ' → ' + fmt(detectedAd.end);
                if (durEl) durEl.textContent = Math.round(detectedAd.duration) + ' 秒 / ' + detectedAd.segmentCount + ' 个分片';
            } else {
                autoBox.style.display = 'none';
                manualBox.style.display = 'block';
            }
        }
        if (!dialogListEl) return;
        if (!segs.length && pendingStart === null) {
            dialogListEl.innerHTML = '<div style="opacity:.55;">暂无标记。播到广告出现时暂停，长按画面打开此面板' +
                (detectedAd ? '，程序会自动框出整段广告，点一下即可标记。' : '，标记起点和终点。') + '</div>';
            return;
        }
        let html = '';
        if (pendingStart !== null) {
            html += '<div style="color:#fb7299;">待配对起点：' + fmt(pendingStart) + '（标记终点后保存）</div>';
        }
        if (segs.length) {
            html += '<div style="margin-top:6px;opacity:.8;">已保存 ' + segs.length + ' 段：</div>';
            segs.forEach(function (seg, i) {
                html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
                    '<span>' + fmt(seg.s) + ' → ' + fmt(seg.e) + '</span>' +
                    '<button data-del="' + i + '" style="border:none;background:none;color:#e05c5c;cursor:pointer;padding:2px 6px;">删除</button></div>';
            });
        }
        dialogListEl.innerHTML = html;
    }

    function openDialog() {
        if (!art) return;
        if (art.playing && art.pause) art.pause(); // 长按即暂停，停在要标记的画面上
        // 打开面板时先试一次自动识别：识别到广告块就省掉手动框起止这两步
        detectedAd = detectAdBlock();
        // 播放器重建后旧面板节点已脱离 DOM（模块级单例还指着它）——
        // 不检查 isConnected 的话面板永远弹不出来（视频倒是暂停了）
        if (dialogEl && !dialogEl.isConnected) {
            try { dialogEl.remove(); } catch (e) { /* 已不在文档 */ }
            dialogEl = null;
        }
        if (!dialogEl) {
            dialogEl = buildDialog();
            dialogTimeEl = dialogEl.querySelector('[data-time]');
            dialogListEl = dialogEl.querySelector('[data-list]');
            dialogEndBtn = dialogEl.querySelector('[data-act="end"]');
            const surface = art.template && art.template.$player;
            (surface || document.body).appendChild(dialogEl);
        }
        renderDialog();
        dialogEl.style.display = 'flex';
    }

    function closeDialog() {
        if (dialogEl) dialogEl.style.display = 'none';
        pendingStart = null; // 关闭面板即放弃未保存的起点
        detectedAd = null;
    }

    // ---------- 标记动作 ----------

    // 一键标记自动识别出的整段广告
    function markDetected() {
        if (!detectedAd) {
            toast('没有识别出广告块，请手动标记起止');
            return;
        }
        const key = sourceKey();
        if (!key) {
            toast('拿不到当前剧集信息，无法保存标记');
            return;
        }
        const s = Math.round(detectedAd.start * 10) / 10;
        const e = Math.round(detectedAd.end * 10) / 10;
        const segs = segmentsFor(key).slice();
        // 与已有区间重叠就合并（取并集），避免重复标记出零碎片段
        let merged = false;
        for (let i = 0; i < segs.length; i++) {
            if (s <= segs[i].e && e >= segs[i].s) {
                segs[i] = { s: Math.min(segs[i].s, s), e: Math.max(segs[i].e, e) };
                merged = true;
                break;
            }
        }
        if (!merged) segs.push({ s: s, e: e });
        segs.sort(function (a, b) { return a.s - b.s; });
        saveSegments(key, segs);
        toast('已标记整段广告 ' + fmt(s) + '~' + fmt(e) + '，之后自动跳过');
        detectedAd = null;
        renderDialog();
    }

    function markStart() {
        if (!art) return;
        const playTime = Math.round((art.currentTime || 0) * 10) / 10;
        // 起点也换算成原始时间轴（与自动标记、与存储格式保持一致）
        const playlist = currentPlaylist();
        const removed = (typeof getRemovedSegmentIds === 'function') ? getRemovedSegmentIds(currentPlaylistUrl()) : null;
        if (playlist && removed && removed.size) {
            pendingStart = playbackToOriginalTime(playlist, playTime, removed);
        } else {
            pendingStart = playTime;
        }
        toast('广告起点已标记 ' + fmt(pendingStart) + '，播到广告结束处再标记终点');
        renderDialog();
    }

    function markEnd() {
        if (!art) return;
        if (pendingStart === null) {
            toast('请先标记广告起点');
            return;
        }
        const playEnd = Math.round((art.currentTime || 0) * 10) / 10;
        // 时长校验必须同轴比较：pendingStart 在 markStart 已换算成原始时间轴，
        // playEnd 此刻还是播放时间轴——自动过滤删过分片时两条轴有偏差，
        // 混轴比较会把合法标记误判成「区间太短」。先换算再比较。
        const playlist = currentPlaylist();
        const removed = (typeof getRemovedSegmentIds === 'function') ? getRemovedSegmentIds(currentPlaylistUrl()) : null;
        let e = playEnd;
        if (playlist && removed && removed.size) {
            e = playbackToOriginalTime(playlist, playEnd, removed);
        }
        if (e - pendingStart < MIN_SEGMENT_SEC) {
            toast('区间太短（不足 ' + MIN_SEGMENT_SEC + ' 秒），像是误触，已忽略');
            return;
        }
        const key = sourceKey();
        if (!key) {
            toast('拿不到当前剧集信息，无法保存标记');
            return;
        }
        const s = pendingStart;
        const segs = segmentsFor(key).slice();
        // 与已有区间重叠就合并（取并集），避免重复标记出零碎片段
        let merged = false;
        for (let i = 0; i < segs.length; i++) {
            if (s <= segs[i].e && e >= segs[i].s) {
                segs[i] = { s: Math.min(segs[i].s, s), e: Math.max(segs[i].e, e) };
                merged = true;
                break;
            }
        }
        if (!merged) segs.push({ s: s, e: e });
        segs.sort(function (a, b) { return a.s - b.s; });
        saveSegments(key, segs);
        pendingStart = null;
        toast('已保存广告片段 ' + fmt(s) + '~' + fmt(e) + '，之后自动跳过');
        renderDialog();
    }

    function removeSegment(index) {
        const key = sourceKey();
        const segs = segmentsFor(key).slice();
        if (index >= 0 && index < segs.length) {
            segs.splice(index, 1);
            saveSegments(key, segs);
            toast('已删除该标记');
        }
        renderDialog();
    }

    // ---------- 自动跳过 ----------

    // 标记区间存的是「原始清单时间轴」上的位置，不是播放时间轴。
    //
    // 为什么：自动过滤每次删掉的分片可能不一样（学习到的广告域名会变、
    // 结构判定结果也可能变），于是播放时间轴的偏移每次都不同。
    // 如果标记存的是播放时间轴，下次播放就会整体错位 —— 跳错位置甚至跳进正片。
    // 存原始时间轴 + 播放时实时换算，才能保证每次都对得上。
    function onTimeUpdate() {
        if (!art || !art.video) return;
        const t = art.currentTime || 0;
        const segs = segmentsFor(sourceKey());
        // 面板开着时只刷新时间数字：高频重建列表会让「删除」按钮点不中
        if (dialogEl && dialogEl.style.display !== 'none' && dialogTimeEl) {
            dialogTimeEl.textContent = fmt(t);
        }
        if (!segs.length) return;
        const playlist = currentPlaylist();
        const removed = (typeof getRemovedSegmentIds === 'function') ? getRemovedSegmentIds(currentPlaylistUrl()) : null;
        for (let i = 0; i < segs.length; i++) {
            const seg = segs[i];
            // 原始时间轴 → 播放时间轴
            let s = seg.s;
            let e = seg.e;
            if (playlist && removed && removed.size && typeof AdBlockLocator !== 'undefined') {
                // 该标记覆盖的分片已经被自动规则删掉了 → 这一段不会播，标记失效
                // （不跳过，也不删记录：过滤规则下次可能不一样，删了就再也找不回来）
                const covered = playlist.segments.filter(x =>
                    x.start >= seg.s && x.start < seg.e && !removed.has(x.id));
                if (!covered.length) continue;
                s = AdBlockLocator.toPlaybackTime(playlist, seg.s, removed);
                e = AdBlockLocator.toPlaybackTime(playlist, seg.e, removed);
            }
            if (t >= s && t < e) {
                art.seek(e + 0.1);
                toast('已跳过标记的广告片段 ' + fmt(s) + '~' + fmt(e));
                break;
            }
        }
    }

    // ---------- 对外 ----------

    window.PlayerAdMarker = {
        // ready 之后由 player_artplayer_handler.js 调一次；open 也可直接带实例调用
        attach: function (instance) {
            art = instance;
            const surface = art.template && art.template.$player;
            if (!surface) return;
            surface.addEventListener('touchstart', onPressStart, { passive: true, capture: true });
            surface.addEventListener('touchmove', onPressMove, { passive: true, capture: true });
            surface.addEventListener('touchend', onPressEnd, { passive: true, capture: true });
            surface.addEventListener('touchcancel', onPressEnd, { passive: true, capture: true });
            surface.addEventListener('mousedown', onPressStart, true);
            surface.addEventListener('mousemove', onPressMove, true);
            surface.addEventListener('mouseup', onPressEnd, true);
            surface.addEventListener('mouseleave', onPressEnd, true);
            surface.addEventListener('click', onClickCapture, true);
            art.on('video:timeupdate', onTimeUpdate);
        },
        open: function (instance) {
            if (instance) art = instance;
            openDialog();
        }
    };
})();
