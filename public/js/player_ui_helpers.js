// Player UI Helper Functions

function showPlayerError(message) {
    const box = document.getElementById('playerError');
    const text = document.getElementById('playerErrorText');
    if (text) text.textContent = message || '视频加载失败';
    if (box) box.classList.remove('hidden');
}

function hidePlayerError() {
    const box = document.getElementById('playerError');
    if (box) box.classList.add('hidden');
}

function getCurrentVideoInfo() {
    try {
        return JSON.parse(localStorage.getItem('currentVideoInfo') || '{}') || {};
    } catch (e) {
        return {};
    }
}

function updateEpisodeInfo() {
    const label = currentEpisodes.length > 0 ? getEpisodeLabel(currentEpisodeIndex) : '';
    const info = document.getElementById('episodeInfo');
    if (info) {
        info.textContent = currentEpisodes.length > 1
            ? `${label} · 共 ${currentEpisodes.length} 集`
            : (currentEpisodes.length === 1 ? '共 1 集' : '无集数信息');
    }
    const subtitle = document.getElementById('videoSubtitle');
    if (subtitle) {
        const sourceName = new URLSearchParams(window.location.search).get('source') || getCurrentVideoInfo().sourceName || '';
        subtitle.textContent = [currentEpisodes.length > 1 ? label : '', sourceName].filter(Boolean).join(' · ');
    }
    document.title = `${currentVideoTitle}${currentEpisodes.length > 1 ? ' ' + label : ''} - LibreTV`;
}

function updateButtonStates() {
    const prevButton = document.getElementById('prevButton');
    const nextButton = document.getElementById('nextButton');
    if (prevButton) prevButton.disabled = currentEpisodeIndex <= 0;
    if (nextButton) nextButton.disabled = currentEpisodeIndex >= currentEpisodes.length - 1;
}

function getGroupCount() {
    return Math.ceil(currentEpisodes.length / EPISODES_PER_GROUP);
}

function renderEpisodeGroups() {
    const container = document.getElementById('episodeGroups');
    if (!container) return;
    const groupCount = getGroupCount();
    if (groupCount <= 1) {
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');
    const order = [...Array(groupCount).keys()];
    if (episodesReversed) order.reverse();
    container.innerHTML = order.map(group => {
        const start = group * EPISODES_PER_GROUP + 1;
        const end = Math.min((group + 1) * EPISODES_PER_GROUP, currentEpisodes.length);
        const label = episodesReversed ? `${end}-${start}` : `${start}-${end}`;
        return `<button type="button" class="chip ${group === currentEpisodeGroup ? 'active' : ''}" data-group="${group}">${label}</button>`;
    }).join('');
}

function renderEpisodes() {
    const episodesList = document.getElementById('episodesList');
    if (!episodesList) return;
    renderEpisodeGroups();

    if (!currentEpisodes || currentEpisodes.length === 0) {
        episodesList.innerHTML = '<div class="empty-tip">没有可用的集数</div>';
        return;
    }

    const start = currentEpisodeGroup * EPISODES_PER_GROUP;
    const end = Math.min(start + EPISODES_PER_GROUP, currentEpisodes.length);
    const indexes = [];
    for (let i = start; i < end; i++) indexes.push(i);
    if (episodesReversed) indexes.reverse();

    const longNames = indexes.some(i => getEpisodeLabel(i).length > 6);
    episodesList.classList.toggle('long-names', longNames);
    episodesList.innerHTML = indexes.map(i => {
        const label = getEpisodeLabel(i);
        const active = i === currentEpisodeIndex;
        return `<button type="button" class="episode-btn ${active ? 'active' : ''}" data-index="${i}" title="${escapeHtml(label)}">
            ${active ? '<span class="episode-playing" aria-hidden="true"><i></i><i></i><i></i></span>' : ''}
            <span class="episode-label">${escapeHtml(label)}</span>
        </button>`;
    }).join('');

    const activeButton = episodesList.querySelector('.episode-btn.active');
    if (activeButton) activeButton.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function updateOrderButton() {
    const orderText = document.getElementById('orderText');
    if (orderText) orderText.textContent = episodesReversed ? '倒序' : '正序';
}

function renderIntro() {
    const container = document.getElementById('introContent');
    if (!container) return;
    const info = getCurrentVideoInfo();
    const sameVideo = !info.title || info.title === currentVideoTitle;
    const data = sameVideo ? info : {};
    const meta = [data.type, data.year, data.area].filter(Boolean).join(' · ');
    const rows = [
        ['导演', data.director],
        ['主演', data.actor],
        ['状态', data.remarks],
        ['来源', new URLSearchParams(window.location.search).get('source') || data.sourceName]
    ].filter(([, value]) => value);
    const cover = data.cover || localStorage.getItem('currentVideoCover') || '';

    container.innerHTML = `
        <div class="intro-head">
            <div class="intro-poster">${posterImgHtml(cover, currentVideoTitle)}</div>
            <div class="intro-meta">
                <h2 class="intro-title">${escapeHtml(currentVideoTitle)}</h2>
                ${meta ? `<p class="intro-sub">${escapeHtml(meta)}</p>` : ''}
                ${rows.map(([k, v]) => `<p class="intro-row"><span>${k}</span>${escapeHtml(v)}</p>`).join('')}
            </div>
        </div>
        <p class="intro-desc">${escapeHtml(stripHtml(data.desc || '')) || '暂无简介'}</p>`;
}

function stripHtml(value) {
    const div = document.createElement('div');
    div.innerHTML = String(value || '');
    return (div.textContent || '').replace(/\s+/g, ' ').trim();
}

function switchWatchTab(tab) {
    document.querySelectorAll('.watch-tabs [data-tab]').forEach(btn => btn.classList.toggle('active', btn.dataset.tab === tab));
    document.querySelectorAll('.watch-tab-panel').forEach(panel => panel.classList.toggle('hidden', panel.id !== `tab-${tab}`));
}

function setupPlayerPageEvents() {
    document.querySelectorAll('.watch-tabs [data-tab]').forEach(btn => {
        btn.addEventListener('click', () => switchWatchTab(btn.dataset.tab));
    });

    const episodesList = document.getElementById('episodesList');
    if (episodesList) {
        episodesList.addEventListener('click', (e) => {
            const btn = e.target.closest('.episode-btn');
            if (btn) playEpisode(parseInt(btn.dataset.index, 10));
        });
    }

    const groups = document.getElementById('episodeGroups');
    if (groups) {
        groups.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-group]');
            if (!btn) return;
            currentEpisodeGroup = parseInt(btn.dataset.group, 10);
            renderEpisodes();
        });
    }

    const autoplayToggle = document.getElementById('autoplayToggle');
    if (autoplayToggle) {
        autoplayToggle.checked = autoplayEnabled;
        autoplayToggle.addEventListener('change', (e) => {
            autoplayEnabled = e.target.checked;
            localStorage.setItem('autoplayEnabled', autoplayEnabled);
        });
    }

    const bind = (id, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    };
    bind('prevButton', playPreviousEpisode);
    bind('nextButton', playNextEpisode);
    bind('orderBtn', toggleEpisodeOrder);
    bind('copyLinkBtn', copyLinks);
    bind('switchSourceBtn', searchOtherSources);
    bind('errorSwitchSourceBtn', searchOtherSources);
    bind('retryBtn', () => switchPlayerUrl(currentVideoUrl, getPlaybackState().position));
    bind('backBtn', goBack);
    bind('homeBtn', () => { saveCurrentProgress(); window.location.href = 'index.html'; });
}
