// Предполагается, что API_SITES, API_CONFIG, CUSTOM_API_CONFIG, createApiError, executeApiRequest доступны глобально
// или будут импортированы, если используется система модулей.

async function handleSingleSourceSearch(searchQuery, source, customApi) {
    if (!searchQuery) throw createApiError('缺少搜索参数');
    if (source === 'custom' && !customApi) throw createApiError('使用自定义API时必须提供API地址');
    // API_SITES[source] validation will be implicitly handled by Rust or if Rust command fails.

    let responseDataJsonString;
    try {
        // 必须走 tauriInvoke（__TAURI_INTERNALS__）：tauri.conf.json 未开
        // withGlobalTauri，window.__TAURI__ 在打包产物里不存在——这里以前
        // 一进来就抛 TypeError，源健康探测把所有源全判「失效」并缓存 6 小时。
        responseDataJsonString = await tauriInvoke('search_videos', {
            query: searchQuery,
            sourceId: source,
            customApiUrl: customApi,
            // config.js 的 API_SITES 原样传入：站点配置的唯一事实源在 JS——
            // 新增站点即用，Rust 不再有会漂移的硬编码表（缺失时 Rust 回退内置表）
            siteConfig: (typeof API_SITES === 'object' && API_SITES) || null,
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


// ---------- 检索相关度与内容过滤（聚合层） ----------
// 实证（scripts/probe-search-relevance.mjs，千与千寻 33 条中 18 条不相关）：
// 部分采集站（bfzy 等）上游按「单字 OR」匹配——查询的任何单字出现在标题里
// 就返回（千星之城/十字架与吸血鬼全是这么漏进来的）。聚合层必须自己做
// 相关度过滤 + 排序，否则用户看到的第一屏全是垃圾。

function normalizeSearchText(s) {
    return String(s || '').toLowerCase()
        .replace(/[\s·・:：，,－—–\-_()（）\[\]【】「」『』·'"“”‘’!！?？.。<>《》]/g, '');
}

// 相关度打分：100=完全同名 90=标题含全词 80=短词包含 60=大部分二字片段
// 命中（改名/别名的近似） 0=无关（丢弃）。多词查询按空白分词、逐词打分取最好。
function searchRelevanceScore(query, title) {
    const t = normalizeSearchText(title);
    // 先分词再逐词归一化（归一化会去空白，必须在拆词之后做——否则多词被拼成一坨）
    const terms = String(query || '').trim().split(/\s+/).map(normalizeSearchText).filter(Boolean);
    if (!terms.length || !t) return 0;
    const best = (term) => {
        if (!term) return 0;
        if (t === term) return 100;
        if (t.includes(term)) return 90;
        // 中文无分词：用二字片段覆盖率做近似（≥50% 算改名/别名级相关）
        if (term.length >= 3) {
            const grams = [];
            for (let i = 0; i < term.length - 1; i++) grams.push(term.slice(i, i + 2));
            let hit = 0;
            for (const g of grams) if (t.includes(g)) hit++;
            if (grams.length && hit / grams.length >= 0.5) return 60;
            return 0;
        }
        return t.includes(term) ? 80 : 0;
    };
    return Math.max(...terms.map(best));
}

// 标题/分类级成人内容过滤（强信号才拦，保守防误伤）：
// 采集站的「伦理/写真/情色」分类与麻豆/福利姬等制作方标记是可靠的成人信号。
// 受「黄色内容过滤」开关（yellowFilterEnabled，默认开）控制——此前该开关
// 只管成人源是否出现在管理列表，搜索结果层从来没有过滤（审计查实）。
const ADULT_TITLE_RE = /(麻豆|福利姬|援交|AV女优|色情|淫|奸|嫖|娼|性爱|做爱|肉体交易|偷情视频|无码|有码|巨乳|人妻出轨|制服诱惑|羞羞漫画|蜜桃影像)/;
const ADULT_CLASS_RE = /(伦理|情色|写真|福利|有色)/;

function isAdultSearchResult(item) {
    const cls = String(item.vod_class || item.type_name || '');
    if (ADULT_CLASS_RE.test(cls)) return true;
    const name = String(item.vod_name || '');
    const blurb = String(item.vod_content || item.vod_blurb || '').slice(0, 200);
    return ADULT_TITLE_RE.test(name) || ADULT_TITLE_RE.test(blurb);
}

function applySearchRelevanceAndFilter(allResults, searchQuery) {
    const yellowFilterOn = (typeof localStorage !== 'undefined')
        ? localStorage.getItem('yellowFilterEnabled') !== 'false'
        : true;
    const scored = [];
    let droppedAdult = 0;
    let droppedIrrelevant = 0;
    for (const item of allResults) {
        if (yellowFilterOn && isAdultSearchResult(item)) { droppedAdult++; continue; }
        const score = searchRelevanceScore(searchQuery, item.vod_name);
        if (score <= 0) { droppedIrrelevant++; continue; }
        scored.push({ item, score });
    }
    // 相关度优先，同分按源内顺序稳定排
    scored.sort((a, b) => b.score - a.score);
    if (droppedAdult || droppedIrrelevant) {
        console.log(`[search] 相关度过滤: 丢弃无关 ${droppedIrrelevant} 条、成人 ${droppedAdult} 条，保留 ${scored.length} 条`);
    }
    return { list: scored.map(x => x.item), droppedAdult, droppedIrrelevant };
}

async function handleAggregatedSearch(searchQuery) {
    const yellowFilterOn = (typeof localStorage !== 'undefined')
        ? localStorage.getItem('yellowFilterEnabled') !== 'false'
        : true;
    const availableSources = Object.keys(API_SITES)
        .filter(key => key !== 'aggregated' && key !== 'custom')
        // 成人源在「黄色内容过滤」开启时不参与聚合（此前只管管理列表显示）
        .filter(key => !(yellowFilterOn && API_SITES[key] && API_SITES[key].adult));
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
        // 相关度过滤 + 排序（无关结果丢弃，精确匹配排前）
        const { list: filteredResults } = applySearchRelevanceAndFilter(allResults, searchQuery);
        const uniqueResults = []; const seen = new Set();
        filteredResults.forEach(item => { const k = `${item.source_code}_${item.vod_id}`; if (!seen.has(k)) { seen.add(k); uniqueResults.push(item); }});
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
        // 相关度过滤 + 排序（与内置源聚合同策略）
        const { list: filteredResults } = applySearchRelevanceAndFilter(allResults, searchQuery);
        const uniqueResults = []; const seen = new Set();
        filteredResults.forEach(item => { const k = `${item.api_url || ''}_${item.vod_id}`; if (!seen.has(k)) { seen.add(k); uniqueResults.push(item); }});
        return { code: 200, list: uniqueResults, source_errors: sourceErrors.length > 0 ? sourceErrors : undefined };
    } catch (error) {
        console.error('自定义API聚合搜索处理错误:', error);
        throw createApiError(`自定义API聚合搜索处理错误: ${error.message || '未知错误'}`, error.statusCode || 500);
    }
}
