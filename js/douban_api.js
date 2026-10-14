// Assuming PROXY_URL is a global constant defined elsewhere (e.g., in a config file or main script)
// If not, it should be passed as an argument or configured. For this refactor, we'll assume it's available.

/**
 * Fetches data from a Douban API endpoint.
 * Uses a proxy and includes a fallback mechanism.
 * @param {string} url - The Douban API URL to fetch (without proxy prefix).
 * @param {string} proxyUrl - The base URL for the proxy service.
 * @returns {Promise<object>} A promise that resolves with the JSON data.
 * @throws {Error} If fetching fails through all mechanisms.
 */
export async function fetchDoubanApiData(url, proxyUrl) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 10000); // 10-second timeout

    const fetchOptions = {
        signal: controller.signal,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Referer': 'https://movie.douban.com/',
            'Accept': 'application/json, text/plain, */*',
        }
    };

    try {
        const response = await fetch(proxyUrl + encodeURIComponent(url), fetchOptions);
        clearTimeout(timeoutId);
        
        if (!response.ok) {
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return await response.json();
    } catch (err) {
        console.error("豆瓣 API 请求失败（直接代理）：", err, "URL:", url);
        
        // Fallback mechanism
        const fallbackProxyUrl = `https://api.allorigins.win/get?url=${encodeURIComponent(url)}`;
        console.log("Attempting fallback API request to:", fallbackProxyUrl);
        
        // New controller and timeout for fallback
        const fallbackController = new AbortController();
        const fallbackTimeoutId = setTimeout(() => fallbackController.abort(), 15000); // Longer timeout for fallback

        try {
            const fallbackResponse = await fetch(fallbackProxyUrl, { signal: fallbackController.signal });
            clearTimeout(fallbackTimeoutId);
            
            if (!fallbackResponse.ok) {
                throw new Error(`备用API请求失败! 状态: ${fallbackResponse.status}`);
            }
            
            const data = await fallbackResponse.json();
            if (data && data.contents) {
                try {
                    return JSON.parse(data.contents);
                } catch (parseError) {
                    console.error("解析备用API内容失败:", parseError, "Content:", data.contents);
                    throw new Error("无法解析备用API的有效JSON数据");
                }
            } else {
                console.error("备用API响应无效:", data);
                throw new Error("备用API无法获取有效数据");
            }
        } catch (fallbackErr) {
            clearTimeout(fallbackTimeoutId); // Ensure timeout is cleared on error too
            console.error("豆瓣 API 备用请求也失败：", fallbackErr, "Fallback URL:", fallbackProxyUrl);
            throw fallbackErr; // Re-throw the error from the fallback attempt
        }
    }
}
