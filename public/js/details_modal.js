// 详情弹层：多源测速、多线路、分组选集、继续观看

const DETAIL_EPISODES_PER_GROUP = 50;
const DETAIL_PROBE_WAIT_MS = 5000;
const DETAIL_RESOLUTION_TIMEOUT_SECS = 6;

const detailState = {
    token: 0,
    id: '',
    sourceCode: '',
    sourceName: '',
    title: '',
    video: null,
    lines: [],
    lineIndex: 0,
    group: 0,
    reversed: false,
    watchedIndex: -1,
    sources: [],
    sourceIndex: -1,
    sourcePicked: false,
    autoPicked: false
};

function getSourceDisplayName(sourceCode) {
    if (!sourceCode) return '';
    if (sourceCode.startsWith('custom_')) {
        const customApi = typeof getCustomApiInfo === 'function' ? getCustomApiInfo(sourceCode.replace('custom_', '')) : null;
        return customApi ? customApi.name : '';
    }
    return API_SITES[sourceCode] ? API_SITES[sourceCode].name : '';
}

function getDetailApiUrl(id, sourceCode) {
    if (sourceCode.startsWith('custom_')) {
        const customApi = typeof getCustomApiInfo === 'function' ? getCustomApiInfo(sourceCode.replace('custom_', '')) : null;
        if (!customApi) throw new Error('找不到该自定义数据源');
        return (customApi.detail || customApi.url) + API_CONFIG.detail.path + encodeURIComponent(id);
    }
    const apiSite = API_SITES[sourceCode];
    if (!apiSite) throw new Error('找不到该数据源配置');
    return (apiSite.detail || apiSite.api) + API_CONFIG.detail.path + encodeURIComponent(id);
}

function parsePlayLines(video) {
    const froms = String(video.vod_play_from || '').split('$$$');
    const groups = String(video.vod_play_url || '').split('$$$');
    return groups.map((group, i) => {
        const episodes = group.split('#').map(entry => {
            const sep = entry.indexOf('$');
            const name = sep >= 0 ? entry.slice(0, sep).trim() : '';
            const url = (sep >= 0 ? entry.slice(sep + 1) : entry).trim();
            return /^https?:\/\//i.test(url) || url.includes('.m3u8') ? { name, url } : null;
        }).filter(Boolean);
        return { name: (froms[i] || '').trim() || `线路${i + 1}`, episodes };
    }).filter(line => line.episodes.length > 0);
}

function preferredLineIndex(lines) {
    const index = lines.findIndex(line => /m3u8/i.test(line.name) || line.episodes.every(ep => /\.m3u8/i.test(ep.url)));
    return index >= 0 ? index : 0;
}

function preferredEpisodeCount(lines) {
    const line = lines[preferredLineIndex(lines)];
    return line ? line.episodes.length : 0;
}

async function fetchVodDetail(id, sourceCode) {
    const response = await tauriInvoke('make_http_request', {
        options: { url: getDetailApiUrl(id, sourceCode), method: 'GET', headers: API_CONFIG.detail.headers, timeout_secs: 15 }
    });
    if (!(response.status >= 200 && response.status < 300)) throw new Error(`接口返回 ${response.status}`);
    let data;
    try {
        data = JSON.parse(response.body);
    } catch (e) {
        throw new Error('返回的数据格式不是有效的 JSON');
    }
    const video = data && Array.isArray(data.list) && data.list.length > 0 ? data.list[0] : null;
    if (!video) throw new Error('没有找到该视频');
    return video;
}

function currentDetailLine() {
    return detailState.lines[detailState.lineIndex] || { name: '', episodes: [] };
}

function openDetailSheet() {
    const modal = document.getElementById('modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    applySheetViewportHeight(modal);
    if (!(history.state && history.state.sheet)) history.pushState({ sheet: true }, '');
}

// 车机上 vh 常与真实可见高度不一致，导致弹层溢出屏幕、底部按钮看不见
// 这里按 window.innerHeight 兜底设定高度，矮屏时同时调整对齐方式
function applySheetViewportHeight(modal) {
    const sheet = modal.querySelector('.sheet');
    if (!sheet) return;
    const height = window.innerHeight || 0;
    if (!height) return;
    // 留出一点上下边距，避免贴边
    const limit = Math.max(240, height - 24);
    sheet.style.maxHeight = `${limit}px`;
    // 屏幕较矮时改用居中，防止底部内容被裁掉
    if (height < 560) {
        modal.style.alignItems = 'center';
        modal.style.padding = '12px';
    } else {
        modal.style.alignItems = '';
        modal.style.padding = '';
    }
}

function closeDetailSheet(fromPopState = false) {
    const modal = document.getElementById('modal');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    detailState.token++;
    if (!fromPopState && history.state && history.state.sheet) history.back();
}

function isDetailSheetOpen() {
    const modal = document.getElementById('modal');
    return !!modal && !modal.classList.contains('hidden');
}

function renderDetailSkeleton(title) {
    document.getElementById('modalTitle').textContent = title || '加载中';
    document.getElementById('modalContent').innerHTML = `
        <div class="detail-skeleton">
            <div style="flex:0 0 104px;aspect-ratio:2/3"></div>
            <div style="flex:1;height:120px"></div>
        </div>
        ${detailSourcesHtml()}
        <div class="detail-episodes" style="margin-top:24px">
            ${'<button type="button" disabled style="opacity:.4">&nbsp;</button>'.repeat(12)}
        </div>`;
}

function showDetails(id, vod_name, sourceCode) {
    if (!id) {
        showToast('视频ID无效', 'error');
        return;
    }
    showDetailSources([{ id, sourceCode }], vod_name);
}

function showDetailSources(items, title) {
    if (window.isPasswordProtected && window.isPasswordVerified && window.isPasswordProtected() && !window.isPasswordVerified()) {
        if (typeof showPasswordModal === 'function') showPasswordModal();
        return;
    }

    const token = ++detailState.token;
    Object.assign(detailState, {
        id: '', sourceCode: '', sourceName: '', title: title || '',
        video: null, lines: [], lineIndex: 0, group: 0,
        reversed: localStorage.getItem('episodesReversed') === 'true', watchedIndex: -1,
        sources: items.map(item => ({
            id: String(item.id),
            sourceCode: item.sourceCode,
            sourceName: getSourceDisplayName(item.sourceCode),
            status: 'loading',
            error: '',
            video: null,
            lines: [],
            probe: 'pending',
            ms: 0,
            remarks: item.remarks || '',
            resolution: null
        })),
        sourceIndex: -1,
        sourcePicked: false,
        autoPicked: false
    });
    renderDetailSkeleton(title);
    openDetailSheet();

    detailState.sources.forEach(source => loadDetailSource(token, source));
    if (detailState.sources.length > 1) setTimeout(() => autoPickFastestSource(token), DETAIL_PROBE_WAIT_MS);
}

async function loadDetailSource(token, source) {
    try {
        const video = await fetchVodDetail(source.id, source.sourceCode);
        if (token !== detailState.token) return;
        Object.assign(source, { status: 'ok', video, lines: parsePlayLines(video), remarks: video.vod_remarks || source.remarks || '' });
        if (isFavorite(source.sourceCode, source.id)) {
            markFavoriteSeen(source.sourceCode, source.id, preferredEpisodeCount(source.lines), video.vod_remarks || '');
            renderFavoritesPage();
        }
        const index = detailState.sources.indexOf(source);
        if (detailState.sourceIndex < 0 || detailState.sourceIndex === index) applyDetailSource(index);
        else renderDetailSources();
        if (detailState.sources.length > 1) probeDetailSource(token, source);
    } catch (error) {
        if (token !== detailState.token) return;
        console.error('获取详情错误:', error);
        Object.assign(source, { status: 'error', error: error && error.message ? error.message : '', probe: 'fail' });
        const index = detailState.sources.indexOf(source);
        const allFailed = detailState.sourceIndex < 0 && detailState.sources.every(s => s.status === 'error');
        if (detailState.sourceIndex === index || allFailed) applyDetailSource(index);
        else renderDetailSources();
        finishProbeIfDone(token);
    }
}

function applyDetailSource(index) {
    const source = detailState.sources[index];
    Object.assign(detailState, {
        sourceIndex: index, id: source.id, sourceCode: source.sourceCode, sourceName: source.sourceName,
        video: source.video, lines: source.lines, lineIndex: preferredLineIndex(source.lines), group: 0, watchedIndex: -1
    });
    if (source.status !== 'ok') {
        renderDetailPending(source);
        renderDetailResolution();
        return;
    }

    if (!detailState.title) detailState.title = source.video.vod_name || '未知视频';
    const historyItem = getViewingHistory().find(item => item.title === detailState.title);
    if (historyItem && typeof historyItem.episodeIndex === 'number') detailState.watchedIndex = historyItem.episodeIndex;
    const total = currentDetailLine().episodes.length;
    detailState.group = detailState.watchedIndex >= 0 && detailState.watchedIndex < total
        ? Math.floor(detailState.watchedIndex / DETAIL_EPISODES_PER_GROUP) : 0;
    renderDetailContent();
    renderDetailResolution();
}

function selectDetailSource(index) {
    const source = detailState.sources[index];
    if (!source || (index === detailState.sourceIndex && source.status !== 'error')) return;
    detailState.sourcePicked = true;
    if (source.status === 'error') {
        Object.assign(source, { status: 'loading', error: '', probe: 'pending' });
        loadDetailSource(detailState.token, source);
    }
    applyDetailSource(index);
}

async function probeDetailSource(token, source) {
    const line = source.lines[preferredLineIndex(source.lines)];
    const url = line && line.episodes[0] ? line.episodes[0].url : '';
    // 测速和分辨率探测并行，两者互不依赖
    const speedTask = (async () => {
        if (!url) return null;
        try {
            return await tauriInvoke('probe_url', { url, timeoutSecs: 5 });
        } catch (e) {
            return null;
        }
    })();
    const resolutionTask = /\.m3u8/i.test(url)
        ? probeM3u8Resolution(url, DETAIL_RESOLUTION_TIMEOUT_SECS)
        : Promise.resolve(null);

    const [result, resolution] = await Promise.all([speedTask, resolutionTask]);
    if (token !== detailState.token) return;
    Object.assign(source, result && result.ok ? { probe: 'ok', ms: result.ms } : { probe: 'fail', ms: 0, resolution: null });
    if (result && result.ok) source.resolution = resolution;
    renderDetailSources();
    renderDetailResolution();
    finishProbeIfDone(token);
}

// 当前选中源的分辨率显示在详情标题下方，实测值优先，否则用备注关键词
function renderDetailResolution() {
    const el = document.getElementById('detailResolution');
    if (!el) return;
    const source = detailState.sources[detailState.sourceIndex];
    const display = resolutionDisplayOf(source);
    if (!display.text) {
        el.textContent = '';
        el.classList.add('hidden');
        return;
    }
    el.textContent = display.fromKeyword ? `${display.text}（备注）` : display.text;
    el.classList.toggle('from-keyword', display.fromKeyword);
    el.classList.remove('hidden');
}

function finishProbeIfDone(token) {
    const done = detailState.sources.every(s => s.status === 'error' || (s.status === 'ok' && s.probe !== 'pending'));
    if (done) autoPickFastestSource(token);
}

function fastestDetailSourceIndex() {
    let best = -1;
    detailState.sources.forEach((source, index) => {
        if (source.probe === 'ok' && (best < 0 || source.ms < detailState.sources[best].ms)) best = index;
    });
    return best;
}

function autoPickFastestSource(token) {
    if (token !== detailState.token || detailState.autoPicked || detailState.sources.length < 2) return;
    detailState.autoPicked = true;
    if (detailState.sourcePicked) return;
    const fastest = fastestDetailSourceIndex();
    if (fastest >= 0 && fastest !== detailState.sourceIndex) applyDetailSource(fastest);
}

function detailSourceStatus(source) {
    if (source.probe === 'ok') return `${source.ms}ms`;
    if (source.probe === 'fail') return '不可用';
    return '测速中';
}

function detailSourceChipsHtml() {
    const measured = detailState.sources.filter(s => s.probe === 'ok').length;
    const fastest = measured >= 2 ? fastestDetailSourceIndex() : -1;
    const rank = source => ({ ok: 0, pending: 1, fail: 2 })[source.probe];
    return detailState.sources
        .map((source, index) => ({ source, index }))
        .sort((a, b) => rank(a.source) - rank(b.source) || a.source.ms - b.source.ms)
        .map(({ source, index }) => {
            const classes = ['chip', 'source-chip'];
            if (index === detailState.sourceIndex) classes.push('active');
            if (source.probe === 'fail') classes.push('unavailable');
            const display = resolutionDisplayOf(source);
            const quality = display.text
                ? `<em class="source-chip-quality${display.fromKeyword ? ' from-keyword' : ''}">${escapeHtml(display.text)}</em>`
                : '';
            return `<button type="button" class="${classes.join(' ')}" data-source-index="${index}">${escapeHtml(source.sourceName || source.sourceCode)}${quality} · ${detailSourceStatus(source)}${index === fastest ? '<em>最快</em>' : ''}</button>`;
        }).join('');
}

function detailSourcesHtml() {
    if (detailState.sources.length < 2) return '';
    return `<div class="detail-section-head"><h3>播放源</h3></div>
        <div id="detailSources" class="chip-row">${detailSourceChipsHtml()}</div>`;
}

function renderDetailSources() {
    const row = document.getElementById('detailSources');
    if (row) row.innerHTML = detailSourceChipsHtml();
}

function detailSheetTitle() {
    return [detailState.title, detailState.sourceName].filter(Boolean).join(' · ');
}

function renderDetailPending(source) {
    document.getElementById('modalTitle').textContent = detailSheetTitle() || '加载中';
    const message = source.status === 'error'
        ? `<p>获取详情失败</p><span>${escapeHtml(source.error || '请稍后重试或换一个数据源')}</span>`
        : '<p>正在获取详情…</p>';
    document.getElementById('modalContent').innerHTML = `${detailSourcesHtml()}<div class="empty-state">${message}</div>`;
}

function renderDetailContent() {
    const video = detailState.video;
    const line = currentDetailLine();
    document.getElementById('modalTitle').textContent = detailSheetTitle();

    const tags = [video.type_name, video.vod_year, video.vod_area, video.vod_lang].filter(Boolean);
    const rows = [['状态', video.vod_remarks], ['导演', video.vod_director], ['主演', video.vod_actor]].filter(([, v]) => v);
    const desc = stripDetailHtml(video.vod_content || video.vod_blurb || '');
    const resumeIndex = detailState.watchedIndex >= 0 && detailState.watchedIndex < line.episodes.length ? detailState.watchedIndex : 0;
    const playLabel = detailState.watchedIndex >= 0 && line.episodes.length > 1
        ? `继续看 ${episodeDisplayName(line.episodes[resumeIndex], resumeIndex, line.episodes.length)}` : '立即播放';

    document.getElementById('modalContent').innerHTML = `
        <div class="detail-head">
            <div class="detail-poster">${posterImgHtml(video.vod_pic, detailState.title)}</div>
            <div class="detail-meta">
                <div class="detail-title">${escapeHtml(detailState.title)}</div>
                <p id="detailResolution" class="detail-resolution hidden"></p>
                ${tags.length ? `<div class="detail-tags">${tags.map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>` : ''}
                ${rows.map(([k, v]) => `<p class="detail-row"><span>${k}</span>${escapeHtml(v)}</p>`).join('')}
                <div class="detail-actions">
                    ${line.episodes.length ? `<button type="button" class="btn-primary" data-play-index="${resumeIndex}">
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>
                        ${escapeHtml(playLabel)}</button>` : ''}
                    ${detailFavoriteButtonHtml()}
                </div>
            </div>
        </div>
        ${desc ? `<p class="detail-desc" data-action="toggle-desc">${escapeHtml(desc)}</p>` : ''}
        ${detailSourcesHtml()}
        ${line.episodes.length ? `
            <div class="detail-section-head">
                <h3>选集 <span class="text-sm font-normal text-gray-500">共 ${line.episodes.length} 集</span></h3>
                <div class="detail-tools">
                    <button type="button" class="text-btn" data-action="order">${detailState.reversed ? '倒序' : '正序'}</button>
                    <button type="button" class="text-btn" data-action="copy">复制链接</button>
                </div>
            </div>
            <div id="detailLines" class="chip-row ${detailState.lines.length > 1 ? '' : 'hidden'}">
                ${detailState.lines.map((l, i) => `<button type="button" class="chip ${i === detailState.lineIndex ? 'active' : ''}" data-line="${i}">${escapeHtml(l.name)} (${l.episodes.length})</button>`).join('')}
            </div>
            <div id="detailGroups" class="chip-row"></div>
            <div id="detailEpisodes" class="detail-episodes"></div>`
        : '<div class="empty-state"><p>没有找到可播放的视频</p><span>换一个数据源试试</span></div>'}`;

    renderDetailEpisodes();
}

// 同一部影片可能已从别的源收藏过，按"已收藏"处理，避免重复收藏
function detailFavoriteSource() {
    const current = detailState.sources[detailState.sourceIndex];
    if (current && isFavorite(current.sourceCode, current.id)) return current;
    return detailState.sources.find(source => isFavorite(source.sourceCode, source.id)) || null;
}

function detailFavoriteButtonHtml() {
    const active = !!detailFavoriteSource();
    return `<button type="button" class="btn-secondary detail-fav ${active ? 'active' : ''}" data-action="favorite">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="${active ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>
        ${active ? '已收藏' : '收藏'}</button>`;
}

function toggleDetailFavorite(button) {
    const favorited = detailFavoriteSource();
    if (favorited) {
        removeFavorite(favorited.sourceCode, favorited.id);
    } else {
        const video = detailState.video || {};
        toggleFavorite({
            id: detailState.id,
            sourceCode: detailState.sourceCode,
            sourceName: detailState.sourceName,
            title: detailState.title,
            cover: video.vod_pic || '',
            type: video.type_name || '',
            year: video.vod_year || '',
            remarks: video.vod_remarks || '',
            episodeCount: preferredEpisodeCount(detailState.lines)
        });
    }
    button.outerHTML = detailFavoriteButtonHtml();
    renderFavoritesPage();
    showToast(favorited ? '已取消收藏' : '已加入收藏', 'success');
}

function stripDetailHtml(value) {
    const div = document.createElement('div');
    div.innerHTML = String(value || '');
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
}

function episodeDisplayName(episode, index, total) {
    if (episode && episode.name) return episode.name;
    return total > 1 ? `第${index + 1}集` : '正片';
}

function renderDetailEpisodes() {
    const container = document.getElementById('detailEpisodes');
    const groupsEl = document.getElementById('detailGroups');
    if (!container) return;
    const episodes = currentDetailLine().episodes;
    const groupCount = Math.ceil(episodes.length / DETAIL_EPISODES_PER_GROUP);
    if (detailState.group >= groupCount) detailState.group = 0;

    if (groupsEl) {
        groupsEl.classList.toggle('hidden', groupCount <= 1);
        const order = [...Array(groupCount).keys()];
        if (detailState.reversed) order.reverse();
        groupsEl.innerHTML = order.map(g => {
            const start = g * DETAIL_EPISODES_PER_GROUP + 1;
            const end = Math.min((g + 1) * DETAIL_EPISODES_PER_GROUP, episodes.length);
            return `<button type="button" class="chip ${g === detailState.group ? 'active' : ''}" data-group="${g}">${detailState.reversed ? `${end}-${start}` : `${start}-${end}`}</button>`;
        }).join('');
    }

    const start = detailState.group * DETAIL_EPISODES_PER_GROUP;
    const indexes = [];
    for (let i = start; i < Math.min(start + DETAIL_EPISODES_PER_GROUP, episodes.length); i++) indexes.push(i);
    if (detailState.reversed) indexes.reverse();

    container.classList.toggle('long-names', indexes.some(i => episodeDisplayName(episodes[i], i, episodes.length).length > 6));
    container.innerHTML = indexes.map(i => {
        const label = episodeDisplayName(episodes[i], i, episodes.length);
        return `<button type="button" class="${i === detailState.watchedIndex ? 'watched' : ''}" data-play-index="${i}" title="${escapeHtml(label)}">${escapeHtml(label)}</button>`;
    }).join('');
}

function playDetailEpisode(index) {
    const line = currentDetailLine();
    const episode = line.episodes[index];
    if (!episode) return;
    const video = detailState.video || {};
    currentEpisodes = line.episodes.map(ep => ep.url);
    currentVideoTitle = detailState.title;
    episodesReversed = detailState.reversed;
    playVideo(episode.url, detailState.title, detailState.sourceCode, index, {
        sourceName: detailState.sourceName,
        cover: video.vod_pic || '',
        episodeNames: line.episodes.map(ep => ep.name || ''),
        info: {
            title: detailState.title,
            cover: video.vod_pic || '',
            type: video.type_name || '',
            year: video.vod_year || '',
            area: video.vod_area || '',
            director: video.vod_director || '',
            actor: video.vod_actor || '',
            remarks: video.vod_remarks || '',
            desc: stripDetailHtml(video.vod_content || video.vod_blurb || ''),
            sourceName: detailState.sourceName,
            lineName: line.name,
            vodId: detailState.id,
            sourceCode: detailState.sourceCode
        }
    });
}

function copyLinks() {
    const episodes = currentDetailLine().episodes.map(ep => ep.url);
    const list = detailState.reversed ? [...episodes].reverse() : episodes;
    navigator.clipboard.writeText(list.join('\r\n'))
        .then(() => showToast('播放链接已复制', 'success'))
        .catch(() => showToast('复制失败，请检查权限', 'error'));
}

function toggleEpisodeOrder() {
    detailState.reversed = !detailState.reversed;
    localStorage.setItem('episodesReversed', detailState.reversed);
    const orderBtn = document.querySelector('#modalContent [data-action="order"]');
    if (orderBtn) orderBtn.textContent = detailState.reversed ? '倒序' : '正序';
    renderDetailEpisodes();
}

function setupDetailSheet() {
    const modal = document.getElementById('modal');
    const content = document.getElementById('modalContent');
    if (!modal || !content) return;

    document.getElementById('modalCloseBtn')?.addEventListener('click', () => closeDetailSheet());
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeDetailSheet();
    });

    content.addEventListener('click', (e) => {
        const playBtn = e.target.closest('[data-play-index]');
        if (playBtn) { playDetailEpisode(parseInt(playBtn.dataset.playIndex, 10)); return; }
        const sourceBtn = e.target.closest('[data-source-index]');
        if (sourceBtn) { selectDetailSource(parseInt(sourceBtn.dataset.sourceIndex, 10)); return; }
        const lineBtn = e.target.closest('[data-line]');
        if (lineBtn) {
            detailState.lineIndex = parseInt(lineBtn.dataset.line, 10);
            detailState.group = 0;
            renderDetailContent();
            return;
        }
        const groupBtn = e.target.closest('[data-group]');
        if (groupBtn) {
            detailState.group = parseInt(groupBtn.dataset.group, 10);
            renderDetailEpisodes();
            return;
        }
        const action = e.target.closest('[data-action]');
        if (!action) return;
        if (action.dataset.action === 'order') toggleEpisodeOrder();
        else if (action.dataset.action === 'copy') copyLinks();
        else if (action.dataset.action === 'favorite') toggleDetailFavorite(action);
        else if (action.dataset.action === 'toggle-desc') action.classList.toggle('expanded');
    });

    window.addEventListener('popstate', () => {
        if (isDetailSheetOpen()) closeDetailSheet(true);
    });

    // 车机旋转屏幕、软键盘弹出都会改变可见高度，重新校准弹层高度
    window.addEventListener('resize', () => {
        if (!isDetailSheetOpen()) return;
        const modal = document.getElementById('modal');
        if (modal) applySheetViewportHeight(modal);
    });
}
