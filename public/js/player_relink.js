// 自动换源：同步来的条目片源常已失效，播放失败时自动搜索其它源并定位到同一集
// 依赖 player_switch_source.js 的搜索与解析能力

const AUTO_RELINK_MAX_EPISODE_GAP = 3;

const autoRelinkState = {
    running: false,
    tried: false
};

// 是否值得为该条目自动换源：同步来的、或本机片源播放失败时
function shouldAutoRelink() {
    if (autoRelinkState.running || autoRelinkState.tried) return false;
    const info = getCurrentVideoInfo();
    // 没有片名就没法搜索
    if (!info || !(info.title || currentVideoTitle)) return false;
    return true;
}

// 当前条目是否标记为「需重新找源」
function currentEntryNeedsRelink() {
    const info = getCurrentVideoInfo();
    if (info && info.needsRelink) return true;
    try {
        const history = JSON.parse(localStorage.getItem('viewingHistory') || '[]');
        if (!Array.isArray(history)) return false;
        const title = info && info.title ? info.title : currentVideoTitle;
        const record = history.find(item => item.title === title);
        return !!(record && record.needsRelink);
    } catch (e) {
        return false;
    }
}

// 清除条目的 needsRelink 标记，避免每次播放都重复搜索
function clearRelinkFlag() {
    const info = getCurrentVideoInfo();
    const title = info && info.title ? info.title : currentVideoTitle;
    if (!title) return;
    try {
        const history = JSON.parse(localStorage.getItem('viewingHistory') || '[]');
        if (!Array.isArray(history)) return;
        let dirty = false;
        history.forEach(item => {
            if (item.title === title && item.needsRelink) {
                delete item.needsRelink;
                dirty = true;
            }
        });
        if (dirty) localStorage.setItem('viewingHistory', JSON.stringify(history));
    } catch (e) { /* 忽略 */ }
}

// 在候选源里挑出总集数最接近原始集数的那个
// 集数差异过大时仍然使用，但会提示用户确认位置是否准确
function pickRelinkCandidate(candidates, targetIndex) {
    if (!candidates.length) return null;
    const usable = candidates.filter(item => Array.isArray(item.episodes) && item.episodes.length);
    if (!usable.length) return null;
    // 优先选能覆盖目标集号的源，其次选速度快的
    const covering = usable.filter(item => item.episodes.length > targetIndex);
    const pool = covering.length ? covering : usable;
    pool.sort((a, b) => {
        // 集数更接近的优先
        const gapA = Math.abs(a.episodes.length - (targetIndex + 1));
        const gapB = Math.abs(b.episodes.length - (targetIndex + 1));
        if (gapA !== gapB) return gapA - gapB;
        return (a.ms || 0) - (b.ms || 0);
    });
    const best = pool[0];
    const episodeCount = best.episodes.length;
    const gap = Math.abs(episodeCount - (targetIndex + 1));
    return {
        item: best,
        episodeIndex: Math.min(targetIndex, episodeCount - 1),
        episodeCount,
        gap,
        // 集数差异超过阈值时，位置可能对不上
        uncertain: gap > AUTO_RELINK_MAX_EPISODE_GAP
    };
}

function showRelinkHint(text) {
    if (typeof art !== 'undefined' && art && art.notice) {
        art.notice.show = text;
    } else if (typeof showToast === 'function') {
        showToast(text, 'info');
    }
}

// 自动换源并播放同一集，保留原播放进度
async function autoRelinkAndPlay(options) {
    const opts = options || {};
    if (autoRelinkState.running) return { ok: false, reason: '正在换源中' };
    autoRelinkState.running = true;
    autoRelinkState.tried = true;

    const targetIndex = typeof currentEpisodeIndex === 'number' ? currentEpisodeIndex : 0;
    const position = typeof getPlaybackState === 'function' ? getPlaybackState().position : 0;
    showRelinkHint(opts.precheck ? '片源已失效，正在自动寻找可用源…' : '当前线路失效，正在自动换源…');

    try {
        if (typeof loadSwitchSources !== 'function') {
            return { ok: false, reason: '换源模块不可用' };
        }
        await loadSwitchSources();
        const items = (typeof switchSourceState !== 'undefined' && Array.isArray(switchSourceState.items))
            ? switchSourceState.items : [];
        // 只考虑探测成功且不是当前源的
        const currentSource = (getCurrentVideoInfo() || {}).sourceCode || '';
        const candidates = items.filter(item => item.probe === 'ok' && item.source_code !== currentSource);
        const picked = pickRelinkCandidate(candidates, targetIndex);
        if (!picked) {
            showRelinkHint('没找到可用的替代源，可手动换源');
            return { ok: false, reason: '没有可用源' };
        }

        const url = picked.item.episodes[picked.episodeIndex];
        if (!url) return { ok: false, reason: '该源缺少对应剧集' };

        // 记录新的片源信息，便于下次直接播放
        const info = { ...(getCurrentVideoInfo() || {}) };
        info.sourceCode = picked.item.source_code;
        info.sourceName = picked.item.source_name || '';
        info.vodId = picked.item.vod_id || '';
        info.needsRelink = false;
        localStorage.setItem('currentVideoInfo', JSON.stringify(info));
        clearRelinkFlag();

        // 更新剧集列表与当前集号，保持与原条目一致的集位置
        currentEpisodes = picked.item.episodes.slice();
        if (Array.isArray(picked.item.episodeNames) && picked.item.episodeNames.length) {
            currentEpisodeNames = picked.item.episodeNames.slice();
            localStorage.setItem('currentEpisodeNames', JSON.stringify(currentEpisodeNames));
        }
        currentEpisodeIndex = picked.episodeIndex;
        currentVideoUrl = url;
        localStorage.setItem('currentEpisodes', JSON.stringify(currentEpisodes));
        localStorage.setItem('currentEpisodeIndex', currentEpisodeIndex);

        const newUrl = new URL(window.location.href);
        newUrl.searchParams.set('url', url);
        newUrl.searchParams.set('index', String(currentEpisodeIndex));
        newUrl.searchParams.set('source_code', picked.item.source_code || '');
        newUrl.searchParams.set('source', picked.item.source_name || '');
        window.history.replaceState({}, '', newUrl);

        if (typeof renderEpisodes === 'function') renderEpisodes();
        if (typeof updateEpisodeInfo === 'function') updateEpisodeInfo();
        if (typeof updateButtonStates === 'function') updateButtonStates();

        // 换源后接着原来的进度继续播
        const resume = position > 10 ? position : 0;
        if (typeof switchPlayerUrl === 'function') switchPlayerUrl(url, resume);

        const message = picked.uncertain
            ? `已换到「${picked.item.source_name || picked.item.source_code}」，共 ${picked.episodeCount} 集，集数与原来源不一致，请确认位置`
            : `已自动换到「${picked.item.source_name || picked.item.source_code}」第 ${picked.episodeIndex + 1} 集`;
        showRelinkHint(message);
        return { ok: true, source: picked.item.source_name, episodeIndex: picked.episodeIndex };
    } catch (e) {
        showRelinkHint('自动换源失败，请手动换源');
        return { ok: false, reason: e.message || '未知错误' };
    } finally {
        autoRelinkState.running = false;
    }
}

// 进入播放页时的预检：同步来的条目直接找源，避免先黑屏再报错
async function precheckRelinkIfNeeded() {
    if (!currentEntryNeedsRelink()) return;
    // 给播放器一点时间先初始化，再决定是否介入
    setTimeout(() => {
        if (typeof playbackStarted !== 'undefined' && playbackStarted) {
            // 原始地址能播，直接清掉标记
            clearRelinkFlag();
            return;
        }
        autoRelinkAndPlay({ precheck: true });
    }, 2500);
}
