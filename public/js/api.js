// 改进的API请求处理函数

async function handleApiRequest(url) {
    const customApi = url.searchParams.get('customApi') || '';
    const customDetail = url.searchParams.get('customDetail') || ''; // Used for custom special detail
    const source = url.searchParams.get('source') || 'heimuer'; 
    // let responseData; // No longer needed at this scope for detail

    try {
        if (url.pathname === '/api/search') {
            const searchQuery = url.searchParams.get('wd');
            if (!searchQuery) throw createApiError('缺少搜索参数');
            
            // Assumes handleSingleSourceSearch is globally available
            const searchResult = await handleSingleSourceSearch(searchQuery, source, customApi);
            return JSON.stringify(searchResult);
        }

        if (url.pathname === '/api/detail') {
            const id = url.searchParams.get('id');
            const sourceCode = url.searchParams.get('source') || 'heimuer'; // Renamed from 'source' to avoid conflict
            
            // Basic validations
            if (!id) throw createApiError('缺少视频ID参数');
            if (!/^[\w-]+$/.test(id)) throw createApiError('无效的视频ID格式');
            if (sourceCode === 'custom' && !customApi && !customDetail) { // If custom, either customApi (for standard) or customDetail (for special) must be present
                 throw createApiError('自定义API模式下缺少API地址或详情页地址');
            }
            if (!API_SITES[sourceCode] && sourceCode !== 'custom') throw createApiError('无效的API来源');

            let detailResult;
            // Assumes handlers from apiDetailHandlers.js are globally available
            if (sourceCode !== 'custom' && API_SITES[sourceCode] && API_SITES[sourceCode].detail) {
                detailResult = await handleSpecialSourceDetail(id, sourceCode);
            } else if (sourceCode === 'custom' && customDetail) {
                detailResult = await handleCustomApiSpecialDetail(id, customDetail);
            } else if (sourceCode === 'custom' && url.searchParams.get('useDetail') === 'true' && customApi) {
                // This case implies customApi should be treated as a special detail page base
                detailResult = await handleCustomApiSpecialDetail(id, customApi);
            } else {
                // Standard detail fetch using JSON API
                detailResult = await handleStandardDetailFetch(id, sourceCode, customApi);
            }
            return JSON.stringify(detailResult);
        }
        throw createApiError('未知的API路径');
    } catch (error) {
        console.error('API路由处理错误:', error); // Changed log message slightly for clarity
        const responseCode = typeof error.statusCode === 'number' ? error.statusCode : 400; // Default to 400 for client-like errors
        return JSON.stringify({ code: responseCode, msg: error.message || '请求处理失败', list: [], episodes: [] });
    }
}

// handleCustomApiSpecialDetail and handleSpecialSourceDetail are now in apiDetailHandlers.js
// handleAggregatedSearch and handleMultipleCustomSearch are now in apiSearchHandlers.js

// 拦截API请求
(function() {
    const originalFetch = window.fetch;
    
    window.fetch = async function(input, init) {
        const requestUrl = typeof input === 'string' ? new URL(input, window.location.origin) : input.url;
        
        if (requestUrl.pathname.startsWith('/api/')) {
            if (window.isPasswordProtected && window.isPasswordVerified) {
                if (window.isPasswordProtected() && !window.isPasswordVerified()) {
                    console.warn("API request blocked due to unverified password.");
                    return new Response(JSON.stringify({code: 401, msg: "Password not verified"}), {status: 401, headers: {'Content-Type': 'application/json'}});
                }
            }
            try {
                const sourceParam = requestUrl.searchParams.get('source');
                const wdParam = requestUrl.searchParams.get('wd');
                const customApiUrlsParam = requestUrl.searchParams.get('customApiUrls');

                // Route to specific handlers for aggregated/multiple custom search
                // These handlers are now in apiSearchHandlers.js and assumed to be global
                if (requestUrl.pathname === '/api/search' && sourceParam === 'aggregated' && wdParam) {
                    const data = await handleAggregatedSearch(wdParam); 
                    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }});
                } else if (requestUrl.pathname === '/api/search' && sourceParam === 'custom' && customApiUrlsParam && wdParam) {
                    const data = await handleMultipleCustomSearch(wdParam, customApiUrlsParam);
                    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }});
                }
                
                // For single source search and all detail calls, use the main router handleApiRequest
                // handleApiRequest itself will call the appropriate specific handler.
                const dataString = await handleApiRequest(requestUrl); 
                return new Response(dataString, { 
                    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }
                });
            } catch (error) {
                console.error('Fetch Interception Error (main interceptor level):', error);
                const statusCode = error.statusCode || 500; // Default to 500 for interceptor level errors
                return new Response(JSON.stringify({
                    code: statusCode,
                    msg: `服务器内部错误 (拦截器): ${error.message || '未知拦截器错误'}`,
                    list: [], episodes: [] 
                }), { status: statusCode, headers: { 'Content-Type': 'application/json' } });
            }
        }
        
        return originalFetch.apply(this, arguments);
    };
})();

async function testSiteAvailability(apiUrl) {
    try {
        // This fetch will be intercepted and routed correctly
        const response = await fetch(`/api/search?wd=test&customApi=${encodeURIComponent(apiUrl)}&source=custom`);
        // The response from fetch interceptor is already a Response object. We need its text content.
        const responseText = await response.text();
        const data = JSON.parse(responseText); 
        return data && data.code === 200 && Array.isArray(data.list);
    } catch (error) {
        console.error('站点可用性测试失败:', error);
        return false;
    }
}
