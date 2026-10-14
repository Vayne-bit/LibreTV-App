// Предполагается, что API_SITES, API_CONFIG, CUSTOM_API_CONFIG, createApiError, executeApiRequest доступны глобально
// или будут импортированы, если используется система модулей.

async function handleSingleSourceSearch(searchQuery, source, customApi) {
    if (!searchQuery) throw createApiError('缺少搜索参数');
    if (!searchQuery) throw createApiError('缺少搜索参数');
    if (source === 'custom' && !customApi) throw createApiError('使用自定义API时必须提供API地址');
    // API_SITES[source] validation will be implicitly handled by Rust or if Rust command fails.

    let responseDataJsonString;
    try {
        // @ts-ignore
        const tauriCore = window.__TAURI__.core;
        responseDataJsonString = await tauriCore.invoke('search_videos', {
            query: searchQuery,
            sourceId: source,
            customApiUrl: customApi,
        });
    } catch (error) {
        // Handle errors from tauri.invoke (e.g., Rust command panicked or returned HttpError)
        console.error(`Tauri invoke 'search_videos' for source '${source}' failed:`, error);
        let errorMessage = `搜索源 '${source}' 失败`;
        if (typeof error === 'string') {
            errorMessage = error;
        } else if (error && typeof error === 'object' && error.error) { // Matches HttpError structure
            errorMessage = `${error.error}${error.details ? ': ' + error.details : ''}`;
        } else if (error && error.message) {
            errorMessage = error.message;
        }
        throw createApiError(errorMessage, error?.status || 500);
    }

    let responseData;
    try {
        responseData = JSON.parse(responseDataJsonString);
    } catch (e) {
        console.error(`Failed to parse JSON response from 'search_videos' for source '${source}':`, responseDataJsonString);
        throw createApiError(`源 '${source}' 返回的JSON数据无效`, 500);
    }
    
    // Validate the structure of the parsed data (as the original function did)
    if (responseData.code && responseData.code !== 200 && responseData.code !== 0 && responseData.code !== 1) { // Allow code 1 for some APIs
        throw createApiError(responseData.msg || `API返回错误代码: ${responseData.code}`, responseData.code);
    }
    if (!responseData || typeof responseData.list === 'undefined') {
        // If code is 1 (often means success but empty list is possible), don't throw if list is missing/empty
        if (responseData.code !== 1) {
            throw createApiError('API返回的数据格式无效: 缺少 list 字段', responseData.code || 500);
        }
        responseData.list = []; // Ensure list exists if code was 1 and list was missing
    }
    if (!Array.isArray(responseData.list)) {
         // If code is 1 and list is not an array (e.g. null), treat as empty
        if (responseData.code === 1 && responseData.list === null) {
            responseData.list = [];
        } else {
            throw createApiError('API返回的数据格式无效: list 字段不是数组', responseData.code || 500);
        }
    }

    // Enrich items with source name and code (this part remains in JS for now)
    const sourceNameDisplay = source === 'custom' 
        ? (customApi ? `自定义 (${new URL(customApi).hostname})` : '自定义源') 
        : (API_SITES[source]?.name || source);

    responseData.list.forEach(item => {
        item.source_name = sourceNameDisplay;
        item.source_code = source;
        if (source === 'custom' && customApi) item.api_url = customApi; // Store the specific custom API URL used
    });

    return { code: 200, list: responseData.list || [] }; // Normalize success code to 200 for the UI
}


async function handleAggregatedSearch(searchQuery) {
    const availableSources = Object.keys(API_SITES).filter(key => key !== 'aggregated' && key !== 'custom');
    if (availableSources.length === 0) throw createApiError('没有可用的API源');

    const searchPromises = availableSources.map(async (source) => {
        const apiUrl = `${API_SITES[source].api}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
        try {
            let sourceData = await executeApiRequest(apiUrl, {
                headers: API_CONFIG.search.headers || {},
                timeoutSecs: 8, // Shorter timeout for aggregated
                sourceForLog: `aggregated-${source}`
            });
            
            if (!sourceData || !Array.isArray(sourceData.list)) throw createApiError(`${source}源返回的数据格式无效`);
            return sourceData.list.map(item => ({ ...item, source_name: API_SITES[source].name, source_code: source }));
        } catch (error) {
            console.warn(`${source}源搜索失败:`, error.message);
            const statusCode = error.statusCode || (error.message && error.message.includes("超时") ? 408 : undefined);
            return { error: true, source_name: API_SITES[source] ? API_SITES[source].name : source, source_code: source, message: error.message, statusCode: statusCode };
        }
    });

    try {
        const resultsArray = await Promise.all(searchPromises);
        let allResults = [], sourceErrors = [];
        resultsArray.forEach(result => {
            if (result.error) sourceErrors.push(result);
            else if (Array.isArray(result)) allResults = allResults.concat(result);
        });
        if (allResults.length === 0 && sourceErrors.length > 0 && sourceErrors.length === availableSources.length) {
            const errMsgs = sourceErrors.map(err => `${err.source_name}: ${err.message}`).join('; ');
            throw createApiError(`所有聚合搜索源均失败: ${errMsgs}`, 503);
        }
        if (allResults.length === 0 && sourceErrors.length < availableSources.length) {
            return { code: 200, list: [], msg: '所有成功响应的源均无搜索结果。部分源可能已失败。', source_errors: sourceErrors.length > 0 ? sourceErrors : undefined };
        }
        const uniqueResults = []; const seen = new Set();
        allResults.forEach(item => { const k = `${item.source_code}_${item.vod_id}`; if (!seen.has(k)) { seen.add(k); uniqueResults.push(item); }});
        uniqueResults.sort((a,b) => (a.vod_name||'').localeCompare(b.vod_name||'') || (a.source_name||'').localeCompare(b.source_name||''));
        return { code: 200, list: uniqueResults, source_errors: sourceErrors.length > 0 ? sourceErrors : undefined };
    } catch (error) {
        console.error('聚合搜索处理错误:', error);
        // Перебрасываем ошибку, чтобы ее мог поймать вызывающий код (например, перехватчик fetch)
        throw createApiError(`聚合搜索处理错误: ${error.message || '未知错误'}`, error.statusCode || 500);
    }
}

async function handleMultipleCustomSearch(searchQuery, customApiUrls) {
    const apiUrls = customApiUrls.split(CUSTOM_API_CONFIG.separator).map(url => url.trim()).filter(url => url.length > 0 && /^https?:\/\//.test(url)).slice(0, CUSTOM_API_CONFIG.maxSources);
    if (apiUrls.length === 0) throw createApiError('没有提供有效的自定义API地址');

    const searchPromises = apiUrls.map(async (apiUrl, index) => {
        const sourceName = `${CUSTOM_API_CONFIG.namePrefix}${index+1}`;
        try {
            const fullUrl = `${apiUrl}${API_CONFIG.search.path}${encodeURIComponent(searchQuery)}`;
            let sourceData = await executeApiRequest(fullUrl, {
                headers: API_CONFIG.search.headers || {},
                timeoutSecs: 8, // Shorter timeout
                sourceForLog: `custom-aggregated-${sourceName}`
            });

            if (!sourceData || !Array.isArray(sourceData.list)) throw createApiError(`自定义API ${sourceName} 返回的数据格式无效`);
            return sourceData.list.map(item => ({ ...item, source_name: sourceName, source_code: 'custom', api_url: apiUrl }));
        } catch (error) {
            console.warn(`自定义API ${sourceName} (${apiUrl}) 搜索失败:`, error.message);
            const statusCode = error.statusCode || (error.message && error.message.includes("超时") ? 408 : undefined);
            return { error: true, source_name: sourceName, api_url: apiUrl, message: error.message, statusCode: statusCode };
        }
    });
    
    try {
        const resultsArray = await Promise.all(searchPromises);
        let allResults = [], sourceErrors = [];
        resultsArray.forEach(result => {
            if (result.error) sourceErrors.push(result);
            else if (Array.isArray(result)) allResults = allResults.concat(result);
        });
        if (allResults.length === 0 && sourceErrors.length > 0 && sourceErrors.length === apiUrls.length) {
             const errMsgs = sourceErrors.map(err => `${err.source_name}: ${err.message}`).join('; ');
            throw createApiError(`所有自定义API聚合搜索源均失败: ${errMsgs}`, 503);
        }
        const uniqueResults = []; const seen = new Set();
        allResults.forEach(item => { const k = `${item.api_url || ''}_${item.vod_id}`; if (!seen.has(k)) { seen.add(k); uniqueResults.push(item); }});
        // Сортировка не указана, но можно добавить, если нужно
        return { code: 200, list: uniqueResults, source_errors: sourceErrors.length > 0 ? sourceErrors : undefined };
    } catch (error) {
        console.error('自定义API聚合搜索处理错误:', error);
        throw createApiError(`自定义API聚合搜索处理错误: ${error.message || '未知错误'}`, error.statusCode || 500);
    }
}
