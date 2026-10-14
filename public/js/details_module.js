// 显示详情 - 修改为支持自定义API
async function showDetails(id, vod_name, sourceCode) {
    // 密码保护校验
    if (window.isPasswordProtected && window.isPasswordVerified) {
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            showPasswordModal && showPasswordModal();
            return;
        }
    }
    if (!id) {
        showToast('视频ID无效', 'error');
        return;
    }
    
    showLoading();
    try {
        // window.currentDetailContext = { id: id, name: vod_name, sourceCode: sourceCode }; // No longer needed for auto-reopening modal
        // console.log('[ShowDetails] Stored currentDetailContext:', window.currentDetailContext);

        // 构建API参数
        let apiParams = '';
        
        // 处理自定义API源
        if (sourceCode.startsWith('custom_')) {
            const customIndex = sourceCode.replace('custom_', '');
            const customApi = getCustomApiInfo(customIndex);
            if (!customApi) {
                showToast('自定义API配置无效', 'error');
                hideLoading();
                return;
            }
            // 传递 detail 字段
            if (customApi.detail) {
                apiParams = '&customApi=' + encodeURIComponent(customApi.url) + '&customDetail=' + encodeURIComponent(customApi.detail) + '&source=custom';
            } else {
                apiParams = '&customApi=' + encodeURIComponent(customApi.url) + '&source=custom';
            }
        } else {
            // 内置API
            apiParams = '&source=' + sourceCode;
        }
        
        if (!tauriConstants || !tauriConstants.invoke) {
            console.error('[MY_APP_DEBUG_APP_DETAIL] Tauri invoke function is not available.');
            throw new Error('Tauri API (invoke) not available for detail request.');
        }
        let detailApiUrl;
        // Construct the full URL for the detail request
        if (sourceCode.startsWith('custom_')) {
            const customIndex = sourceCode.replace('custom_', '');
            const customApi = getCustomApiInfo(customIndex);
            if (!customApi) throw new Error('Custom API not found for detail request');
            const baseDetailUrl = customApi.detail || customApi.url; // Use detail if present, else base url
            detailApiUrl = baseDetailUrl + API_CONFIG.detail.path + encodeURIComponent(id);
        } else {
            const apiSite = API_SITES[sourceCode];
            if (!apiSite) throw new Error('API site config not found for detail request');
            const baseDetailUrl = apiSite.detail || apiSite.api; // Use detail if present, else base api url
            detailApiUrl = baseDetailUrl + API_CONFIG.detail.path + encodeURIComponent(id);
        }

        const requestOptions = {
            url: detailApiUrl,
            method: "GET",
            headers: API_CONFIG.detail.headers,
            timeout_secs: 15 // Example timeout for detail requests
        };
        console.log(`[MY_APP_DEBUG_APP_DETAIL] Invoking make_http_request for details:`, JSON.stringify(requestOptions));

        const rustResponse = await tauriConstants.invoke('make_http_request', { options: requestOptions });

        console.log(`[MY_APP_DEBUG_APP_DETAIL] Detail Response from Rust. Status: ${rustResponse.status}. Body preview: ${(rustResponse.body || "").substring(0,100)}`);

        if (!(rustResponse.status >= 200 && rustResponse.status < 300)) {
            throw new Error(`Failed to fetch details (via Rust). Status: ${rustResponse.status}, Body: ${rustResponse.body}`);
        }
        
        const data = JSON.parse(rustResponse.body);
        
        const modal = document.getElementById('modal');
        const modalTitle = document.getElementById('modalTitle');
        const modalContent = document.getElementById('modalContent');
        
        const videoData = data.list && data.list.length > 0 ? data.list[0] : null;

        // 显示来源信息
        // Try to get source name from API_SITES or customAPIs if not in videoData
        let sourceNameDisplay = '';
        if (videoData && videoData.source_name) {
            sourceNameDisplay = videoData.source_name;
        } else if (sourceCode) {
            if (sourceCode.startsWith('custom_')) {
                const customIndex = sourceCode.replace('custom_', '');
                const customApi = getCustomApiInfo(customIndex);
                if (customApi) sourceNameDisplay = customApi.name;
            } else if (API_SITES[sourceCode]) {
                sourceNameDisplay = API_SITES[sourceCode].name;
            }
        }
        const sourceNameSpan = sourceNameDisplay ? ` <span class="text-sm font-normal text-gray-400">(${(sourceNameDisplay || '').replace(/</g, '<').replace(/>/g, '>')})</span>` : '';
        
        const safeVodName = (vod_name || (videoData ? videoData.vod_name : '未知视频')).replace(/</g, '<').replace(/>/g, '>');
        modalTitle.innerHTML = `<span class="break-words">${safeVodName}</span>${sourceNameSpan}`;
        currentVideoTitle = vod_name || (videoData ? videoData.vod_name : '未知视频');
        
        let episodesRaw = videoData ? videoData.vod_play_url : null;
        let parsedEpisodes = [];

        if (episodesRaw && typeof episodesRaw === 'string') {
            const firstSourceGroup = episodesRaw.split('$$$')[0]; // Take only the first source group
            if (firstSourceGroup) {
                parsedEpisodes = firstSourceGroup.split('#').map(singleEpisodeStr => {
                    const parts = singleEpisodeStr.split('$');
                    if (parts.length > 1 && parts[1] && (parts[1].startsWith('http://') || parts[1].startsWith('https://') || parts[1].includes('.m3u8'))) {
                        return { name: parts[0], url: parts[1].replace(/"/g, '"') };
                    }
                    return null;
                }).filter(ep => ep && ep.url);
            }
            
            console.log('[AppDebug] episodesRaw (full):', episodesRaw);
            console.log('[AppDebug] firstSourceGroup used:', firstSourceGroup);
            console.log('[AppDebug] parsedEpisodes.length:', parsedEpisodes.length);
            console.log('[AppDebug] parsedEpisodes content:', JSON.stringify(parsedEpisodes));
        }
        
        if (parsedEpisodes.length > 0) {
            currentEpisodes = parsedEpisodes.map(ep => ep.url); // Store only URLs for currentEpisodes
            episodesReversed = false; 
            modalContent.innerHTML = `
                <div class="flex justify-end mb-2">
                    <button onclick="toggleEpisodeOrder('${sourceCode}')" class="px-4 py-1 bg-[#222] hover:bg-[#333] border border-[#333] rounded-lg transition-colors flex items-center space-x-1">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v3.586L7.707 9.293a1 1 0 00-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 10.586V7z" clip-rule="evenodd" />
                        </svg>
                        <span>倒序排列</span>
                    </button>
                    <button title="批量复制播放链接" onclick="copyLinks()" class="ml-2 px-2 py-1 bg-[#222] hover:bg-[#333] border border-[#333] text-white rounded-lg transition">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
                        </svg>
                    </button>
                </div>
                <div id="episodesGrid" class="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2">
                    ${renderEpisodes(currentVideoTitle, sourceCode, parsedEpisodes)}
                </div>
            `;
        } else {
            modalContent.innerHTML = '<p class="text-center text-gray-400 py-8">没有找到可播放的视频</p>';
        }
        
        modal.classList.remove('hidden');
    } catch (error) {
        console.error('获取详情错误:', error);
        let errorMsg = '获取详情失败，请稍后重试';
        if (error && error.message && error.message.toLowerCase().includes('json')) {
            errorMsg = '获取详情失败：返回的数据格式不是有效的JSON。';
        } else if (error && error.message) {
            errorMsg = `获取详情失败：${error.message}`;
        }
        showToast(errorMsg, 'error');
    } finally {
        hideLoading();
    }
}

// 辅助函数用于渲染剧集按钮（使用当前的排序状态）
// Accepts parsedEpisodes which is an array of {name, url} objects
function renderEpisodes(vodName, sourceCode, parsedEpisodesArray) {
    if (!parsedEpisodesArray || parsedEpisodesArray.length === 0) return '';

    const episodesToRender = episodesReversed ? [...parsedEpisodesArray].reverse() : [...parsedEpisodesArray];
    
    return episodesToRender.map((episodeData, loopIndex) => { // Renamed 'index' to 'loopIndex' for clarity
        // originalIndex needs to map back to the currentEpisodes array (which stores only URLs)
        // Find the original index in currentEpisodes based on the URL
        const originalUrl = episodeData.url;
        // realIndex is the index in the original currentEpisodes (array of URLs)
        // This is important for playVideo function if it relies on this index for currentEpisodes
        let realIndex = currentEpisodes.indexOf(originalUrl); 
        if (realIndex === -1) { 
            // Fallback if URL not found, though it should be.
            // This fallback uses the position in the potentially reversed parsedEpisodesArray.
            realIndex = episodesReversed ? (parsedEpisodesArray.length - 1 - loopIndex) : loopIndex;
        }

        const safeEpisodeUrl = (episodeData.url || '').replace(/"/g, '"');
        const safeVodName = (vodName || '').replace(/"/g, '"');
        
        // Display number should be based on the visual order (loopIndex)
        const displayEpisodeText = `第${loopIndex + 1}集`;
        // Tooltip can use the name from data, or fallback to display number
        const tooltipText = (episodeData.name || displayEpisodeText).replace(/</g, '<').replace(/>/g, '>');
        
        return `
            <button id="episode-${realIndex}" onclick="playVideo('${safeEpisodeUrl}','${safeVodName}', '${sourceCode}', ${realIndex})" 
                    class="px-4 py-2 bg-[#222] hover:bg-[#333] border border-[#333] rounded-lg transition-colors text-center episode-btn truncate" title="${tooltipText}">
                ${displayEpisodeText}
            </button>
        `;
    }).join('');
}

// 复制视频链接到剪贴板
function copyLinks() {
    const episodes = episodesReversed ? [...currentEpisodes].reverse() : currentEpisodes;
    const linkList = episodes.join('\r\n');
    navigator.clipboard.writeText(linkList).then(() => {
        showToast('播放链接已复制', 'success');
    }).catch(err => {
        showToast('复制失败，请检查浏览器权限', 'error');
    });
}

// 切换排序状态的函数
function toggleEpisodeOrder(sourceCode) {
    episodesReversed = !episodesReversed;
    const episodesGrid = document.getElementById('episodesGrid');
    if (episodesGrid) {
        episodesGrid.innerHTML = renderEpisodes(currentVideoTitle, sourceCode);
    }
    
    const toggleBtn = document.querySelector(`button[onclick="toggleEpisodeOrder('${sourceCode}')"]`);
    if (toggleBtn) {
        toggleBtn.querySelector('span').textContent = episodesReversed ? '正序排列' : '倒序排列';
        const arrowIcon = toggleBtn.querySelector('svg');
        if (arrowIcon) {
            arrowIcon.style.transform = episodesReversed ? 'rotate(180deg)' : 'rotate(0deg)';
        }
    }
}
