// 更新播放视频函数，修改为在新标签页中打开播放页面，并保存到历史记录
function playVideo(url, vod_name, sourceCode, episodeIndex = 0) {
    // 密码保护校验
    if (window.isPasswordProtected && window.isPasswordVerified) {
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            showPasswordModal && showPasswordModal();
            return;
        }
    }
    if (!url) {
        showToast('无效的视频链接', 'error');
        return;
    }
    
    let sourceName = '';
    const modalTitle = document.getElementById('modalTitle');
    if (modalTitle) {
        const sourceSpan = modalTitle.querySelector('span.text-gray-400');
        if (sourceSpan) {
            const sourceText = sourceSpan.textContent;
            const match = sourceText.match(/\(([^)]+)\)/);
            if (match && match[1]) {
                sourceName = match[1].trim();
            }
        }
    }
    
    const currentVideoTitleForStorage = vod_name;
    localStorage.setItem('currentVideoTitle', currentVideoTitleForStorage);
    localStorage.setItem('currentEpisodeIndex', episodeIndex);
    localStorage.setItem('currentEpisodes', JSON.stringify(currentEpisodes));
    localStorage.setItem('episodesReversed', episodesReversed);

    // // 在导航到播放器前，保存当前详情上下文到sessionStorage - REMOVED
    // if (window.currentDetailContext) {
    //     sessionStorage.setItem('returnToEpisodeModal', JSON.stringify(window.currentDetailContext));
    //     console.log('[PlayVideo] Stored returnToEpisodeModal in sessionStorage:', window.currentDetailContext);
    // }

    // 显式隐藏详情弹窗
    const modal = document.getElementById('modal');
    if (modal) {
        modal.classList.add('hidden'); 
        console.log('[AppPlayVideo] Detail modal hidden.');
    } else {
        console.warn('[AppPlayVideo] Detail modal element not found to hide.');
    }
    
    const videoTitleForHistory = vod_name || currentVideoTitle;
    const videoInfo = {
        title: videoTitleForHistory,
        url: url,
        episodeIndex: episodeIndex,
        sourceName: sourceName,
        timestamp: Date.now(),
        episodes: currentEpisodes && currentEpisodes.length > 0 ? [...currentEpisodes] : []
    };
    
    if (typeof addToViewingHistory === 'function') {
        addToViewingHistory(videoInfo);
    }
    
    const playerUrl = `player.html?url=${encodeURIComponent(url)}&title=${encodeURIComponent(videoTitleForHistory)}&index=${episodeIndex}&source=${encodeURIComponent(sourceName)}&source_code=${encodeURIComponent(sourceCode)}`;
    showVideoPlayer(playerUrl);
}

// 弹出播放器页面 (修改为标准页面导航)
function showVideoPlayer(url) {
    // document.getElementById('resultsArea').classList.add('hidden'); // 主页内容会自然消失，无需手动隐藏
    console.log('[AppNavigation] Navigating to player URL:', url);
    window.location.href = url;
}

// 关闭播放器页面 (此函数不再由 player.js 中的 goBack 调用，因为 player.html 将是顶层窗口)
// 如果应用的其他部分仍依赖此函数名，可以保留一个空函数或记录一条消息。
// 鉴于 player.js 的 goBack 逻辑，此函数可能不再需要。
function closeVideoPlayer() {
    console.log('[AppNavigation] closeVideoPlayer called. With full page navigation for player, this function might be obsolete or behave differently.');
    // 如果是从 player.html 通过 history.back() 返回到 index.html,
    // index.html 的 JavaScript 可能会重新运行。
    // 确保 index.html 加载时能正确恢复状态。
    
    // 之前这里的逻辑是移除 iframe 并显示 resultsArea。
    // 现在，当从 player.html 返回时，浏览器会处理页面加载。
    // 我们可能需要确保 index.html 在重新加载或从 bfcache 恢复时正确显示。
    const resultsArea = document.getElementById('resultsArea');
    if (resultsArea && resultsArea.classList.contains('hidden')) {
        resultsArea.classList.remove('hidden');
        console.log('[AppNavigation] Made resultsArea visible upon returning to index.html (if closeVideoPlayer is somehow still called).');
    }

    if (typeof resetSearchArea === 'function') {
        console.log('[AppNavigation] Calling resetSearchArea if closeVideoPlayer is still triggered.');
        resetSearchArea();
    }
}

// 播放上一集
function playPreviousEpisode(sourceCode) {
    if (currentEpisodeIndex > 0) {
        const prevIndex = currentEpisodeIndex - 1;
        const prevUrl = currentEpisodes[prevIndex];
        playVideo(prevUrl, currentVideoTitle, sourceCode, prevIndex);
    }
}

// 播放下一集
function playNextEpisode(sourceCode) {
    if (currentEpisodeIndex < currentEpisodes.length - 1) {
        const nextIndex = currentEpisodeIndex + 1;
        const nextUrl = currentEpisodes[nextIndex];
        playVideo(nextUrl, currentVideoTitle, sourceCode, nextIndex);
    }
}

// 处理播放器加载错误
function handlePlayerError() {
    hideLoading();
    showToast('视频播放加载失败，请尝试其他视频源', 'error');
}
