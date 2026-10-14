// 从详情页进入播放页，并写入观看历史
function playVideo(url, vod_name, sourceCode, episodeIndex = 0, meta = {}) {
    if (window.isPasswordProtected && window.isPasswordVerified && window.isPasswordProtected() && !window.isPasswordVerified()) {
        if (typeof showPasswordModal === 'function') showPasswordModal();
        return;
    }
    if (!url) {
        showToast('无效的视频链接', 'error');
        return;
    }

    const title = vod_name || currentVideoTitle;
    const sourceName = meta.sourceName || '';
    const episodeNames = Array.isArray(meta.episodeNames) ? meta.episodeNames : [];

    localStorage.setItem('currentVideoTitle', title);
    localStorage.setItem('currentEpisodeIndex', episodeIndex);
    localStorage.setItem('currentEpisodes', JSON.stringify(currentEpisodes));
    localStorage.setItem('currentEpisodeNames', JSON.stringify(episodeNames));
    localStorage.setItem('episodesReversed', episodesReversed);
    localStorage.setItem('currentVideoCover', meta.cover || '');
    if (meta.info) localStorage.setItem('currentVideoInfo', JSON.stringify(meta.info));
    else localStorage.removeItem('currentVideoInfo');

    addToViewingHistory({
        title,
        url,
        directVideoUrl: url,
        episodeIndex,
        sourceName,
        sourceCode,
        cover: meta.cover || '',
        info: meta.info,
        timestamp: Date.now(),
        episodes: currentEpisodes && currentEpisodes.length > 0 ? [...currentEpisodes] : [],
        episodeNames
    });

    const params = new URLSearchParams({
        url,
        title,
        index: String(episodeIndex),
        source: sourceName,
        source_code: sourceCode || ''
    });
    const playerUrl = `player.html?${params.toString()}`;

    // Drop the detail sheet's history entry first so Back from the player lands on the page itself.
    if (history.state && history.state.sheet) {
        let navigated = false;
        const go = () => {
            if (navigated) return;
            navigated = true;
            showVideoPlayer(playerUrl);
        };
        window.addEventListener('popstate', go, { once: true });
        setTimeout(go, 400);
        history.back();
        return;
    }
    showVideoPlayer(playerUrl);
}

function showVideoPlayer(url) {
    window.location.href = url;
}
