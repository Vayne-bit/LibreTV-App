// Player Core Logic & Initialization

document.addEventListener('DOMContentLoaded', function () {
    if (!isPasswordVerified()) return;
    initializePageContent();
});

document.addEventListener('passwordVerified', () => {
    initializePageContent();
});

function readJsonArray(key) {
    try {
        const value = JSON.parse(localStorage.getItem(key) || '[]');
        return Array.isArray(value) ? value : [];
    } catch (e) {
        return [];
    }
}

function initializePageContent() {
    const urlParams = new URLSearchParams(window.location.search);
    let videoUrl = urlParams.get('url');
    const title = urlParams.get('title');
    let index = parseInt(urlParams.get('index') || '0', 10) || 0;
    const episodesListParam = urlParams.get('episodes');
    const startPosition = parseInt(urlParams.get('position') || '0', 10) || 0;

    if (videoUrl && videoUrl.includes('player.html')) {
        try {
            const nested = new URLSearchParams(videoUrl.split('?')[1]);
            videoUrl = nested.get('url') || '';
            if (!urlParams.has('index') && nested.get('index')) index = parseInt(nested.get('index'), 10) || 0;
        } catch (e) { console.error('解析嵌套URL出错:', e); }
    }

    currentVideoTitle = title || localStorage.getItem('currentVideoTitle') || '未知视频';
    autoplayEnabled = localStorage.getItem('autoplayEnabled') !== 'false';
    adFilteringEnabled = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false';
    episodesReversed = localStorage.getItem('episodesReversed') === 'true';

    try {
        currentEpisodes = episodesListParam ? JSON.parse(decodeURIComponent(episodesListParam)) : readJsonArray('currentEpisodes');
    } catch (e) {
        currentEpisodes = [];
    }
    const storedTitle = localStorage.getItem('currentVideoTitle');
    if (storedTitle && title && storedTitle !== title && !episodesListParam) {
        currentEpisodes = videoUrl ? [videoUrl] : [];
    }
    if (currentEpisodes.length === 0 && videoUrl) currentEpisodes = [videoUrl];

    const names = readJsonArray('currentEpisodeNames');
    currentEpisodeNames = names.length === currentEpisodes.length ? names : [];

    if (videoUrl && currentEpisodes[index] !== videoUrl) {
        const found = currentEpisodes.indexOf(videoUrl);
        if (found !== -1) index = found;
    }
    if (index < 0 || index >= currentEpisodes.length) index = 0;
    currentEpisodeIndex = index;
    currentEpisodeGroup = Math.floor(index / EPISODES_PER_GROUP);
    currentVideoUrl = videoUrl || currentEpisodes[index] || '';

    const titleEl = document.getElementById('videoTitle');
    if (titleEl) titleEl.textContent = currentVideoTitle;
    const mainTitleEl = document.getElementById('videoMainTitle');
    if (mainTitleEl) mainTitleEl.textContent = currentVideoTitle;

    setupPlayerPageEvents();
    updateEpisodeInfo();
    renderEpisodes();
    updateButtonStates();
    updateOrderButton();
    renderIntro();
    if (currentEpisodes.length <= 1) switchWatchTab('intro');

    if (currentVideoUrl) {
        pendingSeekPosition = startPosition > 10 ? startPosition : getSavedProgress();
        initPlayer(currentVideoUrl);
    } else {
        showPlayerError('无效的视频链接');
    }

    document.addEventListener('keydown', handleKeyboardShortcuts);
    window.addEventListener('beforeunload', saveCurrentProgress);
    window.addEventListener('pagehide', saveCurrentProgress);
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') saveCurrentProgress();
    });
}

function playEpisode(index) {
    if (index < 0 || index >= currentEpisodes.length) {
        showToast(`无效的剧集索引: ${index + 1}`, 'error');
        return;
    }
    if (index === currentEpisodeIndex && art && !videoHasEnded) return;
    if (art && art.video && !videoHasEnded) saveCurrentProgress();
    if (progressSaveInterval) { clearInterval(progressSaveInterval); progressSaveInterval = null; }

    currentEpisodeIndex = index;
    currentVideoUrl = currentEpisodes[index];
    currentEpisodeGroup = Math.floor(index / EPISODES_PER_GROUP);

    const newUrl = new URL(window.location.href);
    newUrl.searchParams.set('index', index);
    newUrl.searchParams.set('url', currentVideoUrl);
    newUrl.searchParams.delete('position');
    window.history.replaceState({}, '', newUrl);

    switchPlayerUrl(currentVideoUrl, getSavedProgress());
    updateEpisodeInfo();
    updateButtonStates();
    renderEpisodes();
    setTimeout(saveToHistory, 3000);
}

function playPreviousEpisode() {
    if (currentEpisodeIndex > 0) playEpisode(currentEpisodeIndex - 1);
}

function playNextEpisode() {
    if (currentEpisodeIndex < currentEpisodes.length - 1) playEpisode(currentEpisodeIndex + 1);
}

function copyLinks() {
    if (!currentVideoUrl) return;
    navigator.clipboard.writeText(currentVideoUrl)
        .then(() => showToast('播放链接已复制', 'success'))
        .catch(() => showToast('复制失败，请检查权限', 'error'));
}

function toggleEpisodeOrder() {
    episodesReversed = !episodesReversed;
    localStorage.setItem('episodesReversed', episodesReversed);
    renderEpisodes();
    updateOrderButton();
}

function searchOtherSources() {
    saveCurrentProgress();
    if (typeof restoreAudioBrightness === 'function') restoreAudioBrightness();
    window.location.href = `index.html#search?q=${encodeURIComponent(currentVideoTitle)}`;
}

function goBack() {
    saveCurrentProgress();
    // 返回前先还原音量与亮度，不能依赖 pagehide 一定触发
    if (typeof restoreAudioBrightness === 'function') restoreAudioBrightness();
    if (window.history.length > 1) {
        window.history.back();
    } else {
        window.location.href = 'index.html';
    }
}
