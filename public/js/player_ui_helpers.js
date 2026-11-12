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
    // 没有集数时下载入口没有意义
    const seasonBtn = document.getElementById('downloadSeasonBtn');
    if (seasonBtn) seasonBtn.classList.toggle('hidden', !(currentEpisodes && currentEpisodes.length > 0));

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
    renderDownloadModal();
}

// 下载入口统一走弹窗：集数按钮上的 24px 角标在手机上根本点不准，还容易连带切集。
// 弹窗里一集一行，点哪集下哪集，状态（未下/下载中/已下载）也在这一份里刷新。
function downloadModalEpisodeState(index) {
    const key = downloadEpisodeKey(currentVideoTitle, index);
    const task = typeof downloadTaskFor === 'function' ? downloadTaskFor(key) : null;
    if (task && (task.status === 'downloading' || task.status === 'queued')) {
        const percent = task.total ? Math.min(99, Math.floor(task.done / task.total * 100)) : 0;
        return { cls: 'busy', text: task.status === 'queued' ? '排队中' : `下载中 ${percent}%` };
    }
    if (typeof isEpisodeDownloaded === 'function' && isEpisodeDownloaded(currentVideoTitle, index)) {
        return { cls: 'done', text: '已下载' };
    }
    return { cls: '', text: '未下载' };
}

function renderDownloadModal() {
    const list = document.getElementById('downloadModalList');
    if (!list) return;
    // 弹窗没打开就不建 DOM：几百集一次全量渲染纯浪费
    const modal = document.getElementById('downloadModal');
    if (modal && modal.classList.contains('hidden')) return;
    if (!currentEpisodes || !currentEpisodes.length) {
        list.innerHTML = '<div class="empty-tip">没有可下载的集数</div>';
        return;
    }
    // 只在打开/状态变化时渲染，避免每集状态变化都整块重绘把滚动位置拽回去
    list.innerHTML = currentEpisodes.map((_, index) => {
        const state = downloadModalEpisodeState(index);
        return `<button type="button" class="download-ep-row ${state.cls}" data-download-index="${index}">
            <span class="download-ep-label">${escapeHtml(getEpisodeLabel(index))}</span>
            <span class="download-ep-state">${state.text}</span>
        </button>`;
    }).join('');
}

function openDownloadModal() {
    const modal = document.getElementById('downloadModal');
    if (!modal) return;
    modal.classList.remove('hidden');
    renderDownloadModal();
}

function closeDownloadModal() {
    const modal = document.getElementById('downloadModal');
    if (modal) modal.classList.add('hidden');
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

function currentFavoriteEntry() {
    const info = getCurrentVideoInfo();
    if (!info.vodId || !info.sourceCode || (info.title && info.title !== currentVideoTitle)) return null;
    return {
        id: info.vodId,
        sourceCode: info.sourceCode,
        sourceName: info.sourceName || '',
        title: currentVideoTitle,
        cover: info.cover || localStorage.getItem('currentVideoCover') || '',
        type: info.type || '',
        year: info.year || '',
        remarks: info.remarks || '',
        episodeCount: currentEpisodes.length
    };
}

function updateFavoriteButton() {
    const btn = document.getElementById('favoriteBtn');
    if (!btn) return;
    const entry = currentFavoriteEntry();
    btn.classList.toggle('hidden', !entry);
    if (!entry) return;
    const active = isFavorite(entry.sourceCode, entry.id);
    btn.classList.toggle('active', active);
    const label = btn.querySelector('span');
    if (label) label.textContent = active ? '已收藏' : '收藏';
}

function togglePlayerFavorite() {
    const entry = currentFavoriteEntry();
    if (!entry) return;
    const added = toggleFavorite(entry);
    updateFavoriteButton();
    showToast(added ? '已加入收藏' : '已取消收藏', 'success');
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
        if (typeof onDownloadChange === 'function') {
            onDownloadChange(() => renderDownloadModal());
        }
        if (typeof refreshDownloadedKeys === 'function') {
            refreshDownloadedKeys().then(() => renderDownloadModal());
        }
    }

    // 下载弹窗：点哪集下哪集。已下好的再点一次是删除，正在下的再点一次是取消。
    const downloadList = document.getElementById('downloadModalList');
    if (downloadList) {
        downloadList.addEventListener('click', (e) => {
            const row = e.target.closest('[data-download-index]');
            if (!row || typeof toggleEpisodeDownload !== 'function') return;
            const index = parseInt(row.dataset.downloadIndex, 10);
            if (!Number.isFinite(index)) return;
            const result = toggleEpisodeDownload(index);
            const message = (result && (result.message || result.reason)) || '';
            if (message && typeof art !== 'undefined' && art && art.notice) art.notice.show = message;
            renderDownloadModal();
        });
    }
    const downloadClose = document.getElementById('downloadModalCloseBtn');
    if (downloadClose) downloadClose.addEventListener('click', closeDownloadModal);
    const downloadBackdrop = document.getElementById('downloadModal');
    if (downloadBackdrop) {
        downloadBackdrop.addEventListener('click', (e) => {
            if (e.target === downloadBackdrop) closeDownloadModal();
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
    bind('downloadSeasonBtn', openDownloadModal);
    bind('downloadModalSeasonBtn', () => {
        if (typeof downloadAllEpisodes !== 'function') return;
        const result = downloadAllEpisodes();
        if (!result || !result.ok) {
            if (art && art.notice) art.notice.show = (result && result.reason) || '加入下载失败';
            return;
        }
        // 一集动辄几百 MB，先把话说在前面，别让用户以为点一下就好
        const message = result.count
            ? `已加入 ${result.count} 集，去「我的 → 下载」看进度`
            : '整季都已在下载或已下载';
        if (art && art.notice) art.notice.show = message;
        if (typeof showToast === 'function') showToast(message, result.count ? 'success' : 'info');
        renderDownloadModal();
    });
    bind('copyLinkBtn', copyLinks);
    bind('favoriteBtn', togglePlayerFavorite);
    // 换源改为就地弹窗，不再退回搜索页
    bind('switchSourceBtn', openSwitchSourceModal);
    bind('errorSwitchSourceBtn', openSwitchSourceModal);
    bind('retryBtn', () => switchPlayerUrl(currentVideoUrl, getPlaybackState().position));
    bind('backBtn', goBack);
    bind('homeBtn', () => {
        saveCurrentProgress();
        if (typeof restoreAudioBrightness === 'function') restoreAudioBrightness();
        window.location.href = 'index.html';
    });
    updateFavoriteButton();
    if (typeof setupSwitchSourceModal === 'function') setupSwitchSourceModal();
}
