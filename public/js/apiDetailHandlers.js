// Предполагается, что API_SITES, API_CONFIG, M3U8_PATTERN, createApiError, executeApiRequest, 
// isLikelyTauriEnvironment, PROXY_URL доступны глобально или будут импортированы.

async function handleStandardDetailFetch(id, sourceCode, customApi) {
    if (!id) throw createApiError('缺少视频ID参数');
    if (!/^[\w-]+$/.test(id)) throw createApiError('无效的视频ID格式'); // Basic validation
    if (sourceCode === 'custom' && !customApi) throw createApiError('使用自定义API时必须提供API地址');
    if (!API_SITES[sourceCode] && sourceCode !== 'custom') throw createApiError('无效的API来源');

    const detailUrl = customApi
        ? `${customApi}${API_CONFIG.detail.path}${id}`
        : `${API_SITES[sourceCode].api}${API_CONFIG.detail.path}${id}`;

    const responseData = await executeApiRequest(detailUrl, {
        headers: API_CONFIG.detail.headers || {},
        timeoutSecs: tauriConstants.TIMEOUT_SECS, // tauriConstants должен быть доступен
        sourceForLog: `detail-${sourceCode}`
    });

    // 检查API响应码，允许 code 0, 1, 200 作为成功状态码
    // 如果 code 存在且不是这些成功码之一，则抛出错误
    if (typeof responseData.code !== 'undefined' && ![0, 1, 200].includes(responseData.code)) {
        throw createApiError(responseData.msg || `API返回错误代码 (详情): ${responseData.code}`, responseData.code);
    }
    
    // 进一步检查列表数据是否有效
    if (!responseData || !responseData.list || !Array.isArray(responseData.list) || responseData.list.length === 0) {
        // 即便 code 是成功的，如果列表数据无效，也可能需要抛出错误，除非某些成功的 code (如1) 明确表示空列表是正常的
        // 为简化，如果 code 是 1 (通常表示“数据列表”成功但可能为空)，且列表为空，我们不立即抛错，后续逻辑会处理空 episodes
        if (responseData.code !== 1 || (responseData.list && responseData.list.length > 0) ) {
             // 如果 code 不是1，或者 code 是1但列表不为空，此时列表为空则报错
        }
        // 如果 code 是 1 且列表为空，我们暂时不报错，让后续逻辑生成空episodes
        // 但如果 code 是 0 或 200，列表为空则应报错
        if ( (responseData.code === 0 || responseData.code === 200) && (!responseData.list || responseData.list.length === 0) ) {
            throw createApiError('获取到的详情内容无效或列表为空 (code: ' + responseData.code + ')');
        }
        // 如果 code 是 1 且列表为空，我们允许它继续，因为 videoDetail = responseData.list[0] 会是 undefined，后续会正确处理
    }
    
    const videoDetail = responseData.list && responseData.list.length > 0 ? responseData.list[0] : {}; // 如果列表为空或不存在，则 videoDetail 为空对象
    let episodes = [];
    if (videoDetail.vod_play_url) {
        const playSources = videoDetail.vod_play_url.split('$$$');
        if (playSources.length > 0) {
            // Only take the first play source for simplicity, as per original logic
            episodes = playSources[0].split('#').map(ep => {
                const parts = ep.split('$');
                return parts.length > 1 ? parts[1] : ''; // URL is usually the second part
            }).filter(url => url && (url.startsWith('http://') || url.startsWith('https://')));
        }
    }
    // Fallback to parsing m3u8 from description if no episodes from vod_play_url
    if (episodes.length === 0 && videoDetail && videoDetail.vod_content) { // Check if videoDetail exists
        const matches = (typeof M3U8_PATTERN !== 'undefined' && M3U8_PATTERN instanceof RegExp) 
                        ? videoDetail.vod_content.match(M3U8_PATTERN) || [] 
                        : [];
        episodes = matches.map(link => link.replace(/^\$/, '')); // Remove leading $ if present
    }

    return {
        code: 200, // Standardize successful response code from this function
        episodes: episodes, 
        detailUrl: detailUrl, // For debugging or reference
        videoInfo: { // Ensure videoDetail properties are accessed safely
            title: videoDetail?.vod_name,
            cover: videoDetail?.vod_pic,
            desc: videoDetail?.vod_content,
            type: videoDetail?.type_name,
            year: videoDetail?.vod_year,
            area: videoDetail?.vod_area,
            director: videoDetail?.vod_director,
            actor: videoDetail?.vod_actor,
            remarks: videoDetail?.vod_remarks,
            source_name: sourceCode === 'custom' ? '自定义源' : API_SITES[sourceCode].name,
            source_code: sourceCode
        }
    };
}
window.handleStandardDetailFetch = handleStandardDetailFetch;


async function handleCustomApiSpecialDetail(id, customApi) {
    const detailUrl = `${customApi}/index.php/vod/detail/id/${id}.html`;
    console.log(`[Debug] CustomApiSpecialDetail: Requesting HTML via Tauri invoke for: ${detailUrl}`);

    try {
        // @ts-ignore
        const tauriCore = window.__TAURI__.core;
        const rustRequestOptions = {
            url: detailUrl,
            method: "GET",
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
            timeout_secs: 15, // Example timeout
            response_as_text: true // Indicate we want raw text
        };
        
        const rustResponse = await tauriCore.invoke('make_http_request', { options: rustRequestOptions });

        if (!(rustResponse.status >= 200 && rustResponse.status < 300)) {
            throw createApiError(`自定义API详情页HTML请求失败 (via Rust): ${rustResponse.status}. Body: ${rustResponse.body.substring(0,200)}`, rustResponse.status);
        }
        
        const html = rustResponse.body; // Body is already text
        const generalPattern = /\$(https?:\/\/[^"'\s]+?\.m3u8)/g;
        let matches = html.match(generalPattern) || [];
        matches = matches.map(link => { link = link.substring(1); const p = link.indexOf('('); return p > 0 ? link.substring(0, p) : link; });
        const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/); const titleText = titleMatch ? titleMatch[1].trim() : '';
        const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/); const descText = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
        
        return { 
            code: 200, 
            episodes: matches, 
            detailUrl: detailUrl, 
            videoInfo: { 
                title: titleText, 
                desc: descText, 
                source_name: '自定义源', 
                source_code: 'custom' 
            }
        };
    } catch (error) {
        console.error(`自定义API详情获取失败 (HTML via Rust):`, error);
        // Ensure the error is an instance of Error for consistent handling upstream
        if (error instanceof Error) {
            throw error;
        } else if (typeof error === 'string') {
            throw createApiError(error);
        } else if (error && error.error) { // Handle HttpError from Rust
             throw createApiError(error.error + (error.details ? `: ${error.details}` : ''), error.status || 500);
        } else {
            throw createApiError('未知错误在 handleCustomApiSpecialDetail (Rust path)');
        }
    }
}
window.handleCustomApiSpecialDetail = handleCustomApiSpecialDetail;

async function handleSpecialSourceDetail(id, sourceCode) {
    const detailUrl = `${API_SITES[sourceCode].detail}/index.php/vod/detail/id/${id}.html`;
    console.log(`[Debug] SpecialSourceDetail: Requesting HTML via Tauri invoke for: ${detailUrl}`);

    try {
        // @ts-ignore
        const tauriCore = window.__TAURI__.core;
        const rustRequestOptions = {
            url: detailUrl,
            method: "GET",
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36' },
            timeout_secs: 15, // Example timeout
            response_as_text: true // Indicate we want raw text
        };

        const rustResponse = await tauriCore.invoke('make_http_request', { options: rustRequestOptions });

        if (!(rustResponse.status >= 200 && rustResponse.status < 300)) {
            throw createApiError(`特殊源详情页HTML请求失败 (via Rust): ${rustResponse.status}. Body: ${rustResponse.body.substring(0,200)}`, rustResponse.status);
        }

        const html = rustResponse.body; // Body is already text
        let matches = [];
        // Specific pattern for 'ffzy' first
        if (sourceCode === 'ffzy') matches = html.match(/\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g) || [];
        // Generic m3u8 pattern if ffzy specific one fails or not ffzy
        if (matches.length === 0) matches = html.match(/\$(https?:\/\/[^"'\s]+?\.m3u8)/g) || [];
        
        matches = [...new Set(matches)].map(link => { // Ensure unique links
            link = link.substring(1); // Remove leading '$'
            const parenIndex = link.indexOf('('); // Remove anything after '(' if present
            return parenIndex > 0 ? link.substring(0, parenIndex) : link;
        });

        const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
        const titleText = titleMatch ? titleMatch[1].trim() : '';
        const descMatch = html.match(/<div[^>]*class=["']sketch["'][^>]*>([\s\S]*?)<\/div>/);
        const descText = descMatch ? descMatch[1].replace(/<[^>]+>/g, ' ').trim() : '';
        
        return {
            code: 200, 
            episodes: matches, 
            detailUrl: detailUrl,
            videoInfo: { 
                title: titleText, 
                desc: descText, 
                source_name: API_SITES[sourceCode].name, 
                source_code: sourceCode 
            }
        };
    } catch (error) {
        console.error(`${API_SITES[sourceCode].name}详情获取失败 (HTML via Rust):`, error);
        // Ensure the error is an instance of Error for consistent handling upstream
        if (error instanceof Error) {
            throw error;
        } else if (typeof error === 'string') {
            throw createApiError(error);
        } else if (error && error.error) { // Handle HttpError from Rust
             throw createApiError(error.error + (error.details ? `: ${error.details}` : ''), error.status || 500);
        } else {
            throw createApiError(`未知错误在 handleSpecialSourceDetail (Rust path) for ${sourceCode}`);
        }
    }
}
window.handleSpecialSourceDetail = handleSpecialSourceDetail;
