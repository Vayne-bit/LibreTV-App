// ============ 人工标记广告片段 ============
// 自动去广告规则（结构法/主机特征法/学习型黑名单）覆盖不了的场景：
// 切片广告与正片同 CDN、无断点标记、无路径特征——机器认不出来，人一眼就能认出来。
// 交互：暂停播放 → 长按画面（600ms）→ 弹出标记面板；也可从齿轮菜单进入。
// 标记起点 → 播到广告结束处再标记终点 → 保存为跳过区间。
// 区间按「视频源地址（origin+pathname）」持久化到 localStorage，
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

    // 视频源标识：origin + pathname（忽略 query，同一集不同 token 也能命中）
    function sourceKey() {
        if (!art) return '';
        const u = (art.hls && art.hls.url) || art.url || (art.video && art.video.currentSrc) || '';
        if (!u || u.indexOf('blob:') === 0) return '';
        try {
            const p = new URL(u, location.href);
            return p.origin + p.pathname;
        } catch (e) {
            return u;
        }
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
        t = Math.max(0, Math.floor(t || 0));
        const m = Math.floor(t / 60);
        const s = t % 60;
        return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function toast(msg) {
        if (art && art.notice) art.notice.show = msg;
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
            '<div style="opacity:.65;font-size:12px;margin-bottom:10px;">当前位置：<span data-time>--:--</span>　·　保存后播放到该区间会自动跳过，仅对当前视频源生效</div>' +
            '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">' +
            '<button data-act="start" style="flex:1;min-width:110px;padding:8px 10px;border:none;border-radius:8px;background:#fb7299;color:#fff;cursor:pointer;">标记为广告起点</button>' +
            '<button data-act="end" style="flex:1;min-width:110px;padding:8px 10px;border:none;border-radius:8px;background:#3a3a46;color:#fff;cursor:pointer;">标记终点并保存</button>' +
            '<button data-act="close" style="padding:8px 12px;border:none;border-radius:8px;background:#2a2a33;color:#bbb;cursor:pointer;">关闭</button>' +
            '</div>' +
            '<div data-list style="font-size:13px;"></div>';
        mask.appendChild(panel);

        mask.addEventListener('click', function (e) {
            const act = e.target && e.target.getAttribute && e.target.getAttribute('data-act');
            if (act === 'start') {
                markStart();
            } else if (act === 'end') {
                markEnd();
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
        if (!dialogListEl) return;
        if (!segs.length && pendingStart === null) {
            dialogListEl.innerHTML = '<div style="opacity:.55;">暂无标记。播到广告出现时暂停，长按画面打开此面板，标记起点和终点。</div>';
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
    }

    // ---------- 标记动作 ----------

    function markStart() {
        if (!art) return;
        pendingStart = Math.round((art.currentTime || 0) * 10) / 10;
        toast('广告起点已标记 ' + fmt(pendingStart) + '，播到广告结束处再标记终点');
        renderDialog();
    }

    function markEnd() {
        if (!art) return;
        if (pendingStart === null) {
            toast('请先标记广告起点');
            return;
        }
        const end = Math.round((art.currentTime || 0) * 10) / 10;
        if (end - pendingStart < MIN_SEGMENT_SEC) {
            toast('区间太短（不足 ' + MIN_SEGMENT_SEC + ' 秒），像是误触，已忽略');
            return;
        }
        const key = sourceKey();
        if (!key) {
            toast('拿不到当前视频源地址，无法保存标记');
            return;
        }
        const segs = segmentsFor(key).slice();
        // 与已有区间重叠就合并（取并集），避免重复标记出零碎片段
        let s = pendingStart, e = end, merged = false;
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

    function onTimeUpdate() {
        if (!art || !art.video) return;
        const t = art.currentTime || 0;
        const segs = segmentsFor(sourceKey());
        // 面板开着时只刷新时间数字：高频重建列表会让「删除」按钮点不中
        if (dialogEl && dialogEl.style.display !== 'none' && dialogTimeEl) {
            dialogTimeEl.textContent = fmt(t);
        }
        if (!segs.length) return;
        for (let i = 0; i < segs.length; i++) {
            if (t >= segs[i].s && t < segs[i].e) {
                art.seek(segs[i].e + 0.1);
                toast('已跳过标记的广告片段 ' + fmt(segs[i].s) + '~' + fmt(segs[i].e));
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
