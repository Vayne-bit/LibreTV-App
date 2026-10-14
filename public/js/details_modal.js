// 详情弹层：多线路、分组选集、继续观看

const DETAIL_EPISODES_PER_GROUP = 50;

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
    watchedIndex: -1
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

function currentDetailLine() {
    return detailState.lines[detailState.lineIndex] || { name: '', episodes: [] };
}

function openDetailSheet() {
    const modal = document.getElementById('modal');
    if (!modal) return;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    if (!(history.state && history.state.sheet)) history.pushState({ sheet: true }, '');
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
        <div class="detail-episodes" style="margin-top:24px">
            ${'<button type="button" disabled style="opacity:.4">&nbsp;</button>'.repeat(12)}
        </div>`;
}

async function showDetails(id, vod_name, sourceCode) {
    if (window.isPasswordProtected && window.isPasswordVerified && window.isPasswordProtected() && !window.isPasswordVerified()) {
        if (typeof showPasswordModal === 'function') showPasswordModal();
        return;
    }
    if (!id) {
        showToast('视频ID无效', 'error');
        return;
    }

    const token = ++detailState.token;
    Object.assign(detailState, {
        id, sourceCode, title: vod_name || '', sourceName: getSourceDisplayName(sourceCode),
        video: null, lines: [], lineIndex: 0, group: 0,
        reversed: localStorage.getItem('episodesReversed') === 'true', watchedIndex: -1
    });
    renderDetailSkeleton(vod_name);
    openDetailSheet();

    try {
        const response = await tauriInvoke('make_http_request', {
            options: { url: getDetailApiUrl(id, sourceCode), method: 'GET', headers: API_CONFIG.detail.headers, timeout_secs: 15 }
        });
        if (token !== detailState.token) return;
        if (!(response.status >= 200 && response.status < 300)) throw new Error(`接口返回 ${response.status}`);
        let data;
        try {
            data = JSON.parse(response.body);
        } catch (e) {
            throw new Error('返回的数据格式不是有效的 JSON');
        }
        const video = data && Array.isArray(data.list) && data.list.length > 0 ? data.list[0] : null;
        if (!video) throw new Error('没有找到该视频');

        detailState.video = video;
        detailState.title = vod_name || video.vod_name || '未知视频';
        detailState.lines = parsePlayLines(video);
        detailState.lineIndex = preferredLineIndex(detailState.lines);

        const historyItem = getViewingHistory().find(item => item.title === detailState.title);
        if (historyItem && typeof historyItem.episodeIndex === 'number') detailState.watchedIndex = historyItem.episodeIndex;
        const total = currentDetailLine().episodes.length;
        detailState.group = detailState.watchedIndex >= 0 && detailState.watchedIndex < total
            ? Math.floor(detailState.watchedIndex / DETAIL_EPISODES_PER_GROUP) : 0;

        renderDetailContent();
    } catch (error) {
        if (token !== detailState.token) return;
        console.error('获取详情错误:', error);
        document.getElementById('modalContent').innerHTML = `
            <div class="empty-state">
                <p>获取详情失败</p>
                <span>${escapeHtml(error && error.message ? error.message : '请稍后重试或换一个数据源')}</span>
            </div>`;
    }
}

function renderDetailContent() {
    const video = detailState.video;
    const line = currentDetailLine();
    document.getElementById('modalTitle').textContent = detailState.sourceName ? `${detailState.title} · ${detailState.sourceName}` : detailState.title;

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
                ${tags.length ? `<div class="detail-tags">${tags.map(t => `<span>${escapeHtml(t)}</span>`).join('')}</div>` : ''}
                ${rows.map(([k, v]) => `<p class="detail-row"><span>${k}</span>${escapeHtml(v)}</p>`).join('')}
                ${line.episodes.length ? `<button type="button" class="btn-primary detail-play" data-play-index="${resumeIndex}">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>
                    ${escapeHtml(playLabel)}</button>` : ''}
            </div>
        </div>
        ${desc ? `<p class="detail-desc" data-action="toggle-desc">${escapeHtml(desc)}</p>` : ''}
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
            lineName: line.name
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
        else if (action.dataset.action === 'toggle-desc') action.classList.toggle('expanded');
    });

    window.addEventListener('popstate', () => {
        if (isDetailSheetOpen()) closeDetailSheet(true);
    });
}
