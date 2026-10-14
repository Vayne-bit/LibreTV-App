// Player Utility Functions

function handleKeyboardShortcuts(e) {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.altKey && e.key === 'ArrowLeft' && currentEpisodeIndex > 0) {
        playPreviousEpisode(); e.preventDefault();
    } else if (e.altKey && e.key === 'ArrowRight' && currentEpisodeIndex < currentEpisodes.length - 1) {
        playNextEpisode(); e.preventDefault();
    } else if (!e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'f' || e.key === 'F') && art) {
        art.fullscreen = !art.fullscreen; e.preventDefault();
    }
}

function getPlaybackState() {
    if (!art || !art.video) return { position: 0, duration: 0 };
    return { position: art.video.currentTime || 0, duration: art.video.duration || 0 };
}

function buildPlayerPageUrl(position) {
    const urlParams = new URLSearchParams(window.location.search);
    const params = new URLSearchParams({
        url: currentVideoUrl,
        title: currentVideoTitle,
        source: urlParams.get('source') || '',
        source_code: urlParams.get('source_code') || '',
        index: String(currentEpisodeIndex),
        position: String(Math.floor(position || 0))
    });
    return `player.html?${params.toString()}`;
}

function saveToHistory() {
    if (!currentEpisodes || currentEpisodes.length === 0 || !currentVideoUrl) return;
    const urlParams = new URLSearchParams(window.location.search);
    const sourceName = urlParams.get('source') || '';
    const { position, duration } = getPlaybackState();
    const cover = localStorage.getItem('currentVideoCover') || '';
    const videoInfo = {
        title: currentVideoTitle,
        directVideoUrl: currentVideoUrl,
        url: buildPlayerPageUrl(position),
        episodeIndex: currentEpisodeIndex,
        sourceName,
        cover,
        timestamp: Date.now(),
        playbackPosition: position,
        duration,
        episodes: [...currentEpisodes],
        episodeNames: [...currentEpisodeNames]
    };
    try {
        const history = JSON.parse(localStorage.getItem('viewingHistory') || '[]');
        const existingIndex = history.findIndex(item => item.title === videoInfo.title);
        if (existingIndex !== -1) {
            const existing = history.splice(existingIndex, 1)[0];
            videoInfo.playbackPosition = position > 10 ? position : (existing.episodeIndex === currentEpisodeIndex ? existing.playbackPosition : 0);
            videoInfo.duration = duration || existing.duration;
            videoInfo.cover = cover || existing.cover || '';
            history.unshift({ ...existing, ...videoInfo });
        } else {
            history.unshift(videoInfo);
        }
        if (history.length > 50) history.splice(50);
        localStorage.setItem('viewingHistory', JSON.stringify(history));
    } catch (e) {
        console.error('保存观看历史失败:', e);
    }
}

function startProgressSaveInterval() {
    if (progressSaveInterval) clearInterval(progressSaveInterval);
    progressSaveInterval = setInterval(saveCurrentProgress, 30000);
}

function saveCurrentProgress() {
    const { position, duration } = getPlaybackState();
    if (!duration || position < 1) return;
    try {
        localStorage.setItem(`videoProgress_${getVideoId()}`, JSON.stringify({ position, duration, timestamp: Date.now() }));
        const history = JSON.parse(localStorage.getItem('viewingHistory') || '[]');
        const idx = history.findIndex(item => item.title === currentVideoTitle);
        if (idx !== -1) {
            const item = history[idx];
            item.episodeIndex = currentEpisodeIndex;
            item.directVideoUrl = currentVideoUrl;
            item.playbackPosition = position;
            item.duration = duration;
            item.timestamp = Date.now();
            item.url = buildPlayerPageUrl(position);
            localStorage.setItem('viewingHistory', JSON.stringify(history));
        }
    } catch (e) { console.error('保存播放进度失败', e); }
}

function getSavedProgress() {
    try {
        const progress = JSON.parse(localStorage.getItem(`videoProgress_${getVideoId()}`) || 'null');
        return progress && typeof progress.position === 'number' ? progress.position : 0;
    } catch (e) {
        return 0;
    }
}

function clearVideoProgress() {
    try { localStorage.removeItem(`videoProgress_${getVideoId()}`); } catch (e) { /* ignore */ }
}

function getVideoId() {
    if (currentVideoUrl) return `${encodeURIComponent(currentVideoUrl)}`;
    return `${encodeURIComponent(currentVideoTitle)}_${currentEpisodeIndex}`;
}

function getEpisodeLabel(index) {
    const name = currentEpisodeNames[index];
    if (name && name.trim()) return name.trim();
    return currentEpisodes.length > 1 ? `第${index + 1}集` : '正片';
}

function formatTime(seconds) {
    if (!seconds || isNaN(seconds)) return '00:00';
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const mm = m.toString().padStart(2, '0');
    const ss = s.toString().padStart(2, '0');
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
