// 搜索功能 - 修改为支持多选API和多页结果
async function search() {
    // 密码保护校验
    if (window.isPasswordProtected && window.isPasswordVerified) {
        if (window.isPasswordProtected() && !window.isPasswordVerified()) {
            showPasswordModal && showPasswordModal();
            return;
        }
    }
    const query = document.getElementById('searchInput').value.trim();
    
    if (!query) {
        showToast('请输入搜索内容', 'info');
        return;
    }
    
    if (selectedAPIs.length === 0) {
        showToast('请至少选择一个API源', 'warning');
        return;
    }
    
    showLoading();
    
    try {
        // 保存搜索历史
        saveSearchHistory(query);
        sessionStorage.setItem('lastSearchQuery', query);
        sessionStorage.setItem('lastPageView', 'searchResults');
        
        // 从所有选中的API源搜索
        let allResults = [];
        const searchPromises = selectedAPIs.map(async (apiId) => {
            let response; 
            let apiUrl = ''; 
            try {
                // Ensure UI is set for search results (within the search page):
                // navigateToTab('search'); // Ensure search tab is active - this might be called before search()
                const resultsAreaEl = document.getElementById('resultsArea');
                if (resultsAreaEl) resultsAreaEl.classList.remove('hidden');
                
                // No need to manipulate #searchArea or #doubanArea visibility here,
                // as they are on different pages now.
                
                let apiName, apiBaseUrl;
                
                if (apiId.startsWith('custom_')) {
                    const customIndex = apiId.replace('custom_', '');
                    const customApi = getCustomApiInfo(customIndex);
                    if (!customApi) return [];
                    apiBaseUrl = customApi.url;
                    apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
                    apiName = customApi.name;
                } else {
                    if (!API_SITES[apiId]) return [];
                    apiBaseUrl = API_SITES[apiId].api;
                    apiUrl = apiBaseUrl + API_CONFIG.search.path + encodeURIComponent(query);
                    apiName = API_SITES[apiId].name;
                }
                
                if (!tauriConstants || !tauriConstants.invoke) {
                    console.error(`[MY_APP_DEBUG_APP_SEARCH] API ${apiId} Tauri invoke function is not available.`);
                    return [];
                }
                const rustRequestOptions = {
                    url: apiUrl,
                    method: "GET",
                    headers: API_CONFIG.search.headers,
                    timeout_secs: Math.floor(AGGREGATED_SEARCH_CONFIG.timeout / 1000) || 8
                };
                console.log(`[MY_APP_DEBUG_APP_SEARCH] API ${apiId} Invoking make_http_request for main search:`, JSON.stringify(rustRequestOptions));
                
                const rustResponse = await tauriConstants.invoke('make_http_request', { options: rustRequestOptions });

                console.log(`[MY_APP_DEBUG_APP_SEARCH] API ${apiId} Response from Rust. Status: ${rustResponse.status}. Body preview: ${(rustResponse.body || "").substring(0,100)}`);

                if (!(rustResponse.status >= 200 && rustResponse.status < 300)) {
                    console.error(`API ${apiId} (${apiUrl}) 请求失败 (via Rust)，状态码: ${rustResponse.status}, Body: ${rustResponse.body}`);
                    return [];
                }
                
                let data;
                try {
                    data = JSON.parse(rustResponse.body);
                } catch (parseError) {
                    console.error(`API ${apiId} (${apiUrl}) 无法解析JSON (via Rust): ${parseError.message}. Body: ${rustResponse.body}`);
                    // 尝试处理返回HTML的情况 (例如 allorigins.win 包装)
                    if (rustResponse.body && rustResponse.body.toLowerCase().includes('<html')) {
                         console.warn(`API ${apiId} (${apiUrl}) via Rust returned HTML. This might indicate an issue with the API or a block page.`);
                    }
                    return [];
                }
                
                if (!data || !data.list || !Array.isArray(data.list)) { 
                    console.warn(`API ${apiId} (${apiUrl}) 返回的数据格式不符合预期 (缺少 list 数组，即使在备用后):`, data);
                    return [];
                }
                
                const results = data.list.map(item => ({
                    ...item,
                    source_name: apiName,
                    source_code: apiId,
                    api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined
                }));
                
                const pageCount = data.pagecount || 1;
                const pagesToFetch = Math.min(pageCount - 1, API_CONFIG.search.maxPages - 1);
                
                if (pagesToFetch > 0) {
                    const additionalPagePromises = [];
                    for (let page = 2; page <= pagesToFetch + 1; page++) {
                        const pageUrl = apiBaseUrl + API_CONFIG.search.pagePath
                            .replace('{query}', encodeURIComponent(query))
                            .replace('{page}', page);
                        
                        const pagePromise = (async () => {
                            let pageResponse; 
                            let pageResponseText; // Define pageResponseText here
                            try {
                                if (!tauriConstants || !tauriConstants.invoke) {
                                    console.error(`[MY_APP_DEBUG_APP_SEARCH] API ${apiId} Page ${page} Tauri invoke function is not available.`);
                                    return [];
                                }
                                const pageRequestOptions = {
                                    url: pageUrl,
                                    method: "GET",
                                    headers: API_CONFIG.search.headers,
                                    timeout_secs: Math.floor(AGGREGATED_SEARCH_CONFIG.timeout / 1000) || 8
                                };
                                console.log(`[MY_APP_DEBUG_APP_SEARCH] API ${apiId} Invoking make_http_request for page ${page}:`, JSON.stringify(pageRequestOptions));

                                const pageRustResponse = await tauriConstants.invoke('make_http_request', { options: pageRequestOptions });
                                
                                console.log(`[MY_APP_DEBUG_APP_SEARCH] API ${apiId} Page ${page} Response from Rust. Status: ${pageRustResponse.status}. Body preview: ${(pageRustResponse.body || "").substring(0,100)}`);

                                if (!(pageRustResponse.status >= 200 && pageRustResponse.status < 300)) {
                                    console.error(`API ${apiId} (${pageUrl}) 分页请求失败 (via Rust)，状态码: ${pageRustResponse.status}, Body: ${pageRustResponse.body}`);
                                    return [];
                                }
                                
                                let pageData;
                                try {
                                    pageData = JSON.parse(pageRustResponse.body);
                                } catch (parseError) {
                                    console.error(`API ${apiId} (${pageUrl}) 分页无法解析JSON (via Rust): ${parseError.message}. Body: ${pageRustResponse.body}`);
                                    return [];
                                }

                                if (!pageData || !pageData.list || !Array.isArray(pageData.list)) {
                                    console.warn(`API ${apiId} (${pageUrl}) 分页返回的数据格式不符合预期 (缺少 list 数组，即使在备用后):`, pageData);
                                    return [];
                                }
                                
                                return pageData.list.map(item => ({
                                    ...item,
                                    source_name: apiName,
                                    source_code: apiId,
                                    api_url: apiId.startsWith('custom_') ? getCustomApiInfo(apiId.replace('custom_', ''))?.url : undefined
                                }));
                            } catch (error) { 
                                console.warn(`API ${apiId} 第${page}页 (${pageUrl}) 搜索失败:`, error.message);
                                // Simplified catch block for pagePromise
                                return [];
                            }
                        })();
                        additionalPagePromises.push(pagePromise);
                    }
                    const additionalResults = await Promise.all(additionalPagePromises);
                    additionalResults.forEach(pageResults => {
                        if (pageResults.length > 0) {
                            results.push(...pageResults);
                        }
                    });
                }
                return results;
            } catch (error) { 
                console.warn(`API ${apiId} (${apiUrl || 'URL未定义'}) 搜索最外层捕获失败:`, error.message);
                return [];
            }
        });
        
        const resultsArray = await Promise.all(searchPromises);
        
        resultsArray.forEach(results => {
            if (Array.isArray(results) && results.length > 0) {
                allResults = allResults.concat(results);
            }
        });
        
        const searchResultsCount = document.getElementById('searchResultsCount');
        if (searchResultsCount) {
            searchResultsCount.textContent = allResults.length;
        }
        
        // UI for search results page is handled by navigateToTab('search')
        // and the inherent structure of #page-search.
        // We just need to ensure resultsArea within #page-search is visible.
        const resultsAreaEl = document.getElementById('resultsArea');
        if (resultsAreaEl) resultsAreaEl.classList.remove('hidden');
        
        const resultsDiv = document.getElementById('results');
        
        if (!allResults || allResults.length === 0) {
            resultsDiv.innerHTML = `
                <div class="col-span-full text-center py-16">
                    <svg class="mx-auto h-12 w-12 text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" 
                              d="M9.172 16.172a4 4 0 015.656 0M9 10h.01M15 10h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <h3 class="mt-2 text-lg font-medium text-gray-400">没有找到匹配的结果</h3>
                    <p class="mt-1 text-sm text-gray-500">请尝试其他关键词或更换数据源</p>
                </div>
            `;
            hideLoading();
            return;
        }

        const yellowFilterEnabled = localStorage.getItem('yellowFilterEnabled') === 'true';
        if (yellowFilterEnabled) {
            const banned = ['伦理片','福利','里番动漫','门事件','萝莉少女','制服诱惑','国产传媒','cosplay','黑丝诱惑','无码','日本无码','有码','日本有码','SWAG','网红主播', '色情片','同性片','福利视频','福利片'];
            allResults = allResults.filter(item => {
                const typeName = item.type_name || '';
                return !banned.some(keyword => typeName.includes(keyword));
            });
        }

        const safeResults = allResults.map(item => {
            const safeId = item.vod_id ? item.vod_id.toString().replace(/[^\w-]/g, '') : '';
            const safeName = (item.vod_name || '').toString()
                .replace(/</g, '<')
                .replace(/>/g, '>')
                .replace(/"/g, '"');
            const sourceInfo = item.source_name ? 
                `<span class="bg-[#222] text-xs px-1.5 py-0.5 rounded-full">${item.source_name}</span>` : '';
            const sourceCode = item.source_code || '';
            
            const apiUrlAttr = item.api_url ? 
                `data-api-url="${item.api_url.replace(/"/g, '"')}"` : '';
            
            const hasCover = item.vod_pic && item.vod_pic.startsWith('http');
            
            return `
                <div class="card-hover bg-[#111] rounded-lg overflow-hidden cursor-pointer transition-all hover:scale-[1.02] h-full shadow-sm hover:shadow-md" 
                     onclick="showDetails('${safeId}','${safeName}','${sourceCode}')" ${apiUrlAttr}>
                    <div class="flex h-full">
                        ${hasCover ? `
                        <div class="relative flex-shrink-0 search-card-img-container">
                            <img src="${item.vod_pic}" alt="${safeName}" 
                                 class="h-full w-full object-cover transition-transform hover:scale-110" 
                                 onerror="this.onerror=null; this.src='https://via.placeholder.com/300x450?text=无封面'; this.classList.add('object-contain');" 
                                 loading="lazy">
                            <div class="absolute inset-0 bg-gradient-to-r from-black/30 to-transparent"></div>
                        </div>` : ''}
                        
                        <div class="p-2 flex flex-col flex-grow">
                            <div class="flex-grow">
                                <h3 class="font-semibold mb-2 break-words line-clamp-2 ${hasCover ? '' : 'text-center'}" title="${safeName}">${safeName}</h3>
                                
                                <div class="flex flex-wrap ${hasCover ? '' : 'justify-center'} gap-1 mb-2">
                                    ${(item.type_name || '').toString().replace(/</g, '<') ? 
                                      `<span class="text-xs py-0.5 px-1.5 rounded bg-opacity-20 bg-blue-500 text-blue-300">
                                          ${(item.type_name || '').toString().replace(/</g, '<')}
                                      </span>` : ''}
                                    ${(item.vod_year || '') ? 
                                      `<span class="text-xs py-0.5 px-1.5 rounded bg-opacity-20 bg-purple-500 text-purple-300">
                                          ${item.vod_year}
                                      </span>` : ''}
                                </div>
                                <p class="text-gray-400 line-clamp-2 overflow-hidden ${hasCover ? '' : 'text-center'} mb-2">
                                    ${(item.vod_remarks || '暂无介绍').toString().replace(/</g, '<')}
                                </p>
                            </div>
                            
                            <div class="flex justify-between items-center mt-1 pt-1 border-t border-gray-800">
                                ${sourceInfo ? `<div>${sourceInfo}</div>` : '<div></div>'}
                            </div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
        resultsDiv.innerHTML = safeResults;
    } catch (error) {
        console.error('搜索错误:', error);
        if (error.name === 'AbortError') {
            showToast('搜索请求超时，请检查网络连接', 'error');
        } else {
            showToast('搜索请求失败，请稍后重试', 'error');
        }
    } finally {
        hideLoading();
    }
}
