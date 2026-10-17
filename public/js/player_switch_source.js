// 播放页换源弹窗：就地搜索其他源并切换，不返回搜索页

const SWITCH_SOURCE_PROBE_TIMEOUT_SECS = 6;

const switchSourceState = {
    open: false,
    loading: false,
    token: 0,
    items: [],
    resolved: []
};

function getSwitchSourceModal() {
    return document.getElementById('switchSourceModal');
}

function currentSwitchEpisodeIndex() {
    return typeof currentEpisodeIndex === 'number' ? currentEpisodeIndex : 0;
}

// 从播放页当前上下文里取用于搜索的片名和源信息
function switchSourceContext() {
    const info = getCurrentVideoInfo();
    return {
        title: info.title || currentVideoTitle || '',
        sourceCode: info.sourceCode || '',
        vodId: info.vodId || '',
        info
    };
}

function switchSourceRowHtml(item) {
    const active = item.source_code === switchSourceContext().sourceCode;
    const classes = ['switch-source-row'];
    if (active) classes.push('active');
    // 只显示真实探测到的结果，探测不到就不显示，避免误导
    const quality = item.resolution ? formatResolution(item.resolution.width, item.resolution.height) : '';
    const status = item.probe === 'ok'
        ? `${item.ms}ms`
        : item.probe === 'fail' ? '不可用'
        : item.probe === 'pending' ? '测速中' : '';
    const badge = quality ? `<em class="switch-source-quality">${escapeHtml(quality)}</em>` : '';
    const episodes = item.episodeCount ? `<span class="switch-source-meta">${item.episodeCount} 集</span>` : '';
    return `<button type="button" class="${classes.join(' ')}" data-switch-index="${item.index}">
        <span class="switch-source-name">${escapeHtml(item.source_name || item.source_code)}${active ? ' · 当前' : ''}</span>
        ${badge}
        <span class="switch-source-status">${escapeHtml(status)}</span>
        ${episodes}
    </button>`;
}

// 播放页不加载 search_logic.js，这里保留一份与首页完全一致的标题归一化规则
function normalizeSwitchTitle(name) {
    if (typeof normalizeVodTitle === 'function') return normalizeVodTitle(name);
    return String(name || '').replace(/[\s\p{P}]/gu, '').toLowerCase();
}

function renderSwitchSourceList() {
    const list = document.getElementById('switchSourceList');
    if (!list) return;
    if (switchSourceState.loading) {
        list.innerHTML = '<div class="empty-state"><p>正在搜索其他源…</p></div>';
        return;
    }
    if (!switchSourceState.items.length) {
        const hint = switchSourceState.error || '没有找到其他源';
        const sub = switchSourceState.error ? '' : '<span>片名可能与其他源的命名不一致</span>';
        list.innerHTML = `<div class="empty-state"><p>${escapeHtml(hint)}</p>${sub}</div>`;
        return;
    }
    const rank = item => {
        const value = { ok: 0, pending: 1, fail: 2 }[item.probe];
        return typeof value === 'number' ? value : 3;
    };
    const ordered = [...switchSourceState.items].sort((a, b) => rank(a) - rank(b) || a.ms - b.ms);
    list.innerHTML = ordered.map(switchSourceRowHtml).join('');
}

// 用标题重新搜索所有已启用源，做标题归一化后只保留同名影片
function collectSwitchSourceMatches(results, title) {
    const target = normalizeSwitchTitle(title);
    const seen = new Set();
    const matches = [];
    results.forEach(item => {
        const key = normalizeSwitchTitle(item.vod_name);
        if (!key || key !== target) return;
        if (seen.has(item.source_code)) return;
        seen.add(item.source_code);
        matches.push(item);
    });
    return matches;
}

function switchSourceTargetUrl(item) {
    const currentEpisode = currentSwitchEpisodeIndex();
    const episodes = Array.isArray(item.episodes) && item.episodes.length ? item.episodes : [];
    if (!episodes.length) return '';
    return episodes[Math.min(currentEpisode, episodes.length - 1)] || episodes[0] || '';
}

function pickSwitchSourceEpisode(itemName, itemIndex) {
    const row = switchSourceState.items[itemIndex];
    if (!row) return;
    const url = switchSourceTargetUrl(row);
    if (!url) {
        showToast('该源没有可用剧集', 'error');
        return;
    }
    const position = typeof getPlaybackState === 'function' ? getPlaybackState().position : 0;
    closeSwitchSourceModal();

    // 切源后保持同名剧集的同一集号，并沿用当前播放进度
    currentVideoTitle = row.vod_name || currentVideoTitle;
    currentEpisodes = row.episodes.slice();
    currentEpisodeNames = row.episodeNames.slice();
    currentEpisodeIndex = Math.min(currentSwitchEpisodeIndex(), currentEpisodes.length - 1);
    episodesReversed = false;
    localStorage.setItem('currentEpisodes', JSON.stringify(currentEpisodes));
    localStorage.setItem('currentEpisodeNames', JSON.stringify(currentEpisodeNames));
    localStorage.setItem('currentEpisodeIndex', currentEpisodeIndex);
    const info = { ...(switchSourceContext().info || {}) };
    info.sourceCode = row.source_code;
    info.sourceName = row.source_name || '';
    info.vodId = row.vod_id || '';
    info.episodeNames = undefined;
    localStorage.setItem('currentVideoInfo', JSON.stringify(info));

    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('url', url);
    newUrl.searchParams.set('index', String(currentEpisodeIndex));
    newUrl.searchParams.set('source_code', row.source_code || '');
    newUrl.searchParams.set('source', row.source_name || '');
    window.history.replaceState({}, '', newUrl);

    if (typeof renderEpisodes === 'function') renderEpisodes();
    if (typeof updateEpisodeInfo === 'function') updateEpisodeInfo();
    if (typeof updateButtonStates === 'function') updateButtonStates();
    switchPlayerUrl(url, position > 10 ? position : 0);
    showToast(`已切换到 ${row.source_name || row.source_code}`, 'success');
}

async function probeSwitchSource(item) {
    const url = switchSourceTargetUrl(item);
    if (!url) {
        item.probe = 'fail';
        return;
    }
    // 测速和分辨率探测可以并行
    const [speed, resolution] = await Promise.all([
        (async () => {
            try {
                const result = await tauriInvoke('probe_url', { url, timeoutSecs: SWITCH_SOURCE_PROBE_TIMEOUT_SECS });
                return { ok: !!(result && result.ok), ms: result && result.ms ? result.ms : 0 };
            } catch (e) {
                return { ok: false, ms: 0 };
            }
        })(),
        /\.m3u8/i.test(url) ? probeM3u8Resolution(url, SWITCH_SOURCE_PROBE_TIMEOUT_SECS) : Promise.resolve(null)
    ]);
    item.probe = speed.ok ? 'ok' : 'fail';
    item.ms = speed.ms;
    item.resolution = resolution;
}

// 播放页没有加载 details_modal.js，这里补一份精简版详情解析
function switchSourceDetailUrl(vodId, sourceCode) {
    if (!sourceCode || !API_SITES[sourceCode]) return '';
    const site = API_SITES[sourceCode];
    return (site.detail || site.api) + API_CONFIG.detail.path + encodeURIComponent(vodId);
}

async function switchSourceFetchDetail(vodId, sourceCode) {
    const url = switchSourceDetailUrl(vodId, sourceCode);
    if (!url) throw new Error('找不到该数据源配置');
    const response = await tauriInvoke('make_http_request', {
        options: { url, method: 'GET', headers: API_CONFIG.detail.headers, timeout_secs: 15 }
    });
    if (!(response.status >= 200 && response.status < 300)) throw new Error(`接口返回 ${response.status}`);
    const data = JSON.parse(response.body);
    const video = data && Array.isArray(data.list) && data.list.length > 0 ? data.list[0] : null;
    if (!video) throw new Error('没有找到该视频');
    return video;
}

function switchSourceParseLines(video) {
    const froms = String(video.vod_play_from || '').split('$$$');
    const groups = String(video.vod_play_url || '').split('$$$');
    const lines = groups.map((group, i) => {
        const episodes = group.split('#').map(entry => {
            const sep = entry.indexOf('$');
            const name = sep >= 0 ? entry.slice(0, sep).trim() : '';
            const url = (sep >= 0 ? entry.slice(sep + 1) : entry).trim();
            return /^https?:\/\//i.test(url) || url.includes('.m3u8') ? { name, url } : null;
        }).filter(Boolean);
        return { name: (froms[i] || '').trim() || `线路${i + 1}`, episodes };
    }).filter(line => line.episodes.length > 0);
    const preferred = lines.findIndex(line => /m3u8/i.test(line.name) || line.episodes.every(ep => /\.m3u8/i.test(ep.url)));
    return { lines, index: preferred >= 0 ? preferred : 0 };
}

// 详情接口能拿到各源的剧集列表，随后探测真实分辨率与速度
async function resolveSwitchSourceItem(item) {
    try {
        const video = await switchSourceFetchDetail(item.vod_id, item.source_code);
        const parsed = switchSourceParseLines(video);
        const line = parsed.lines[parsed.index] || parsed.lines[0];
        if (line && line.episodes.length) {
            item.episodes = line.episodes.map(ep => ep.url);
            item.episodeNames = line.episodes.map(ep => ep.name || '');
            item.episodeCount = line.episodes.length;
        }
        item.remarks = video.vod_remarks || item.remarks || '';
    } catch (e) {
        item.detailError = true;
    }
    await probeSwitchSource(item);
}

// 播放页没有加载 app_globals.js，直接从 localStorage 读取用户勾选的源，
// 不依赖脚本加载顺序，也不会因为变量未定义而搜不到任何源
function readSelectedSourceCodes() {
    if (typeof selectedAPIs !== 'undefined' && Array.isArray(selectedAPIs) && selectedAPIs.length) {
        return selectedAPIs.slice();
    }
    try {
        const stored = JSON.parse(localStorage.getItem('selectedAPIs') || '[]');
        if (Array.isArray(stored) && stored.length) return stored;
    } catch (e) { /* 落到下面的默认值 */ }
    return ['tyyszy', 'xiaomaomi', 'dyttzy', 'bfzy', 'ruyi'];
}

function readCustomSourceList() {
    if (typeof customAPIs !== 'undefined' && Array.isArray(customAPIs) && customAPIs.length) {
        return customAPIs.slice();
    }
    try {
        const stored = JSON.parse(localStorage.getItem('customAPIs') || '[]');
        if (Array.isArray(stored)) return stored;
    } catch (e) { /* ignore */ }
    return [];
}

async function loadSwitchSources() {
    const token = ++switchSourceState.token;
    const context = switchSourceContext();
    switchSourceState.items = [];
    switchSourceState.loading = true;
    renderSwitchSourceList();

    if (!context.title) {
        switchSourceState.loading = false;
        renderSwitchSourceList();
        return;
    }

    const sources = readSelectedSourceCodes();
    const customAPIsList = readCustomSourceList();
    const jobs = [];
    sources.forEach(code => jobs.push(handleSingleSourceSearch(context.title, code, null)));
    customAPIsList.forEach(custom => {
        const url = custom && (custom.url || custom.api);
        if (url) jobs.push(handleSingleSourceSearch(context.title, 'custom', url));
    });

    if (!jobs.length) {
        switchSourceState.loading = false;
        switchSourceState.error = '没有可用的数据源，请先在设置里勾选';
        renderSwitchSourceList();
        return;
    }

    const settled = await Promise.allSettled(jobs);
    if (token !== switchSourceState.token) return;

    const found = [];
    settled.forEach(result => {
        if (result.status !== 'fulfilled' || !result.value || !Array.isArray(result.value.list)) return;
        found.push(...result.value.list);
    });

    const matches = collectSwitchSourceMatches(found, context.title).map((item, index) => ({
        index,
        vod_id: item.vod_id,
        vod_name: item.vod_name,
        source_code: item.source_code,
        source_name: item.source_name || item.source_code,
        remarks: item.vod_remarks || '',
        episodes: [],
        episodeNames: [],
        episodeCount: 0,
        probe: 'pending',
        ms: 0,
        resolution: null
    }));

    switchSourceState.items = matches;
    switchSourceState.loading = false;
    renderSwitchSourceList();

    for (const item of matches) {
        if (token !== switchSourceState.token) return;
        await resolveSwitchSourceItem(item);
        if (token !== switchSourceState.token) return;
        renderSwitchSourceList();
    }
}

function openSwitchSourceModal() {
    const modal = getSwitchSourceModal();
    if (!modal) return;
    switchSourceState.open = true;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    loadSwitchSources();
}

function closeSwitchSourceModal() {
    const modal = getSwitchSourceModal();
    if (!modal) return;
    switchSourceState.open = false;
    switchSourceState.token++;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
}

function setupSwitchSourceModal() {
    const modal = getSwitchSourceModal();
    if (!modal) return;
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeSwitchSourceModal();
    });
    document.getElementById('switchSourceCloseBtn')?.addEventListener('click', closeSwitchSourceModal);
    document.getElementById('switchSourceList')?.addEventListener('click', (e) => {
        const row = e.target.closest('[data-switch-index]');
        if (!row) return;
        pickSwitchSourceEpisode(row.dataset.switchIndex, parseInt(row.dataset.switchIndex, 10));
    });
}
