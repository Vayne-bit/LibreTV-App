// This file will handle all interactions with the Douban API.
// Functions to be moved here include:
// - fetchDoubanData
// - fetchDoubanTags (or its equivalent using the new API)
// - New functions to construct URLs and fetch data from the new Douban filter API (/j/new_search_subjects)

console.log('douban_api.js loaded');

const DOUBAN_API_CACHE_DURATION_MS = 10 * 60 * 1000; // 10 minutes cache
const DOUBAN_API_MAX_RETRIES = 5; // Original attempt + 5 retries (total 6 attempts)
const INITIAL_RETRY_DELAY_MS = 1500; // 1.5 seconds initial delay
const MAX_SINGLE_RETRY_DELAY_MS = 15000; // Max delay for a single retry (15 seconds)

// Correct API base URL for the new search subjects endpoint.
const DOUBAN_NEW_SEARCH_API_BASE = 'https://movie.douban.com/j/new_search_subjects';

const USER_AGENTS = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36'
];

function getRandomUserAgent() {
    return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// Fetches data from the Douban Top List Chart API.
// genreName: e.g., "剧情", "喜剧"
// params: { start: 0, limit: 20, interval_id: '100:90', action: '' }
async function fetchDoubanChartTopList(genreName, params = {}) {
    const genreId = DOUBAN_CHART_GENRE_IDS[genreName];
    if (typeof genreId === 'undefined') {
        console.error(`[Douban API] Unknown genre name for chart: ${genreName}`);
        return { subjects: [], error: { msg: `Unknown genre name: ${genreName}` } };
    }

    const queryParams = new URLSearchParams();
    queryParams.append('type', genreId);
    queryParams.append('interval_id', params.interval_id || '100:90'); // Default interval_id
    queryParams.append('action', params.action || ''); // Default action
    queryParams.append('start', params.start || 0);
    queryParams.append('limit', params.limit || 20);

    const urlToFetch = `https://movie.douban.com/j/chart/top_list?${queryParams.toString()}`;
    
    console.log(`[Douban API] Fetching chart top list for genre "${genreName}" (ID: ${genreId}): ${urlToFetch}`);
    // The chart API returns an array directly, fetchDoubanData needs to handle this.
    // We'll adapt the response in fetchDoubanData or handle it here.
    // For now, let's assume fetchDoubanData can be adapted or we adapt its output.
    const rawData = await fetchDoubanData(urlToFetch);

    // Adapt the response: The chart API returns an array directly.
    // Our existing UI components expect an object with a 'subjects' key.
    if (Array.isArray(rawData)) {
        return { subjects: rawData };
    } else if (rawData && Array.isArray(rawData.subjects)) { // Already in expected format (e.g. from cache or error)
        return rawData;
    } else if (rawData && rawData.error) { // Error object from fetchDoubanData
        return { subjects: [], error: rawData.error };
    }
    // If rawData is something else (e.g. unexpected format from API or error not caught by fetchDoubanData)
    console.warn(`[Douban API] Unexpected data format from chart top list for ${genreName}:`, rawData);
    return { subjects: [] };
}


// Fetches data using the new Douban search API structure.
// params can be an object like { sort, range, tags, start, genres, countries }
// OR it can be an object { urlToFetch: 'full_url_to_new_api_endpoint' } if URL is pre-constructed.
async function fetchNewDoubanSearch(params = {}) {
    let urlToFetch;
    if (params.urlToFetch) {
        urlToFetch = params.urlToFetch;
    } else {
        const queryParams = new URLSearchParams();
        if (params.sort) queryParams.append('sort', params.sort);
        if (params.range) queryParams.append('range', params.range);
        if (params.tags) queryParams.append('tags', params.tags);
        if (params.start) queryParams.append('start', params.start);
        if (params.genres) queryParams.append('genres', params.genres);
        if (params.countries) queryParams.append('countries', params.countries);
        // Ensure page_limit and page_start are not accidentally passed if old param names are used
        // The new API uses 'range' and 'start'.
        urlToFetch = `${DOUBAN_NEW_SEARCH_API_BASE}?${queryParams.toString()}`;
    }
    
    console.log(`[Douban API] Fetching new search subjects: ${urlToFetch}`);
    return fetchDoubanData(urlToFetch); // Use the common fetchDoubanData for the actual request
}

// Common function to fetch data from Douban, used by both old and new API calls.
async function fetchDoubanData(url) {
    const cacheKey = `douban_api_cache_${url}`; // Prefix to avoid potential key collisions

    // Try to retrieve from cache first
    try {
        const cachedItemRaw = sessionStorage.getItem(cacheKey);
        if (cachedItemRaw) {
            const cachedItem = JSON.parse(cachedItemRaw);
            if (cachedItem && cachedItem.timestamp && cachedItem.data) {
                if ((Date.now() - cachedItem.timestamp) < DOUBAN_API_CACHE_DURATION_MS) {
                    console.log(`[Douban API Cache] Using cached response for ${url}`);
                    return Promise.resolve(cachedItem.data); // Return cached data
                } else {
                    console.log(`[Douban API Cache] Cache expired for ${url}`);
                    sessionStorage.removeItem(cacheKey); // Remove expired item
                }
            }
        }
    } catch (e) {
        console.warn(`[Douban API Cache] Error reading from cache for ${url}:`, e);
        sessionStorage.removeItem(cacheKey); // Remove potentially corrupted item
    }

    console.log('[MY_APP_DEBUG_DOUBAN] fetchDoubanData called with URL (via Rust - no valid cache):', url);

    let currentDelay = INITIAL_RETRY_DELAY_MS;
    for (let attempt = 0; attempt <= DOUBAN_API_MAX_RETRIES; attempt++) {
        const requestOptions = {
            url: url, method: "GET",
            headers: {
                'User-Agent': getRandomUserAgent(), // Use a random User-Agent
                'Referer': 'https://movie.douban.com/',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                'X-Requested-With': 'XMLHttpRequest'
            },
            timeout_secs: 20 
        };
        
        if (attempt > 0) {
            console.log(`[Douban API] Retrying request for ${url}, attempt ${attempt + 1}/${DOUBAN_API_MAX_RETRIES + 1}`);
        } else {
            console.log('[MY_APP_DEBUG_DOUBAN] Invoking make_http_request with options:', JSON.stringify(requestOptions));
        }

        if (attempt === 0) {
            // For the very first attempt in the app's lifecycle for a Douban API call,
            // add a small delay to give Tauri's invoke mechanism a bit more time if it's a cold start.
            // This is a targeted fix for the initial load issue.
            console.log('[Douban API] First attempt for this URL, adding a small pre-delay.');
            await new Promise(resolve => setTimeout(resolve, 500)); // 500ms delay
        }

        try {
            if (typeof tauriConstants === 'undefined' || !tauriConstants.invoke) {
                 console.warn('Tauri API (invoke) not available for Douban request.');
                 return { subjects: [] }; 
            }

            const response = await tauriConstants.invoke('make_http_request', { options: requestOptions });
            console.log(`[MY_APP_DEBUG_DOUBAN] Response from Rust command (Attempt ${attempt + 1}). Status:`, response.status);

            if (response.status >= 200 && response.status < 300) {
                try {
                    let jsonData = JSON.parse(response.body);

                    // Handle different Douban API response structures
                    if (url.startsWith(DOUBAN_NEW_SEARCH_API_BASE) && typeof jsonData.data !== 'undefined' && Array.isArray(jsonData.data) && typeof jsonData.subjects === 'undefined') {
                        // New search API: data is in jsonData.data
                        console.log('[MY_APP_DEBUG_DOUBAN] New API (/j/new_search_subjects) response detected with "data" array. Reformatting to "subjects".');
                        jsonData = { subjects: jsonData.data };
                    } else if (url.startsWith('https://movie.douban.com/j/chart/top_list') && Array.isArray(jsonData)) {
                        // Chart API: data is the array itself
                        console.log('[MY_APP_DEBUG_DOUBAN] Chart API (/j/chart/top_list) response detected as direct array. Wrapping in "subjects".');
                        // No, we don't wrap here. fetchDoubanData should return the raw JSON structure.
                        // The calling function (fetchDoubanChartTopList) will handle the wrapping.
                        // So, if it's an array from chart/top_list, we return it as is.
                        // The cache will store the array.
                    }
                    // For /j/search_subjects, data is already in jsonData.subjects
                    // For /j/search_tags, data is in jsonData.tags
                    
                    const isRateLimited = jsonData.msg && jsonData.msg.includes("检测到有异常请求");

                    // Check for successful data structure or rate limit
                    // For chart/top_list, jsonData itself is the array of subjects.
                    const hasData = typeof jsonData.subjects !== 'undefined' || 
                                    typeof jsonData.tags !== 'undefined' ||
                                    (url.startsWith('https://movie.douban.com/j/chart/top_list') && Array.isArray(jsonData));

                    if (!isRateLimited && hasData) {
                        try {
                            const itemToCache = { timestamp: Date.now(), data: jsonData };
                            sessionStorage.setItem(cacheKey, JSON.stringify(itemToCache));
                            console.log(`[Douban API Cache] Response for ${url} cached.`);
                        } catch (e) {
                            console.warn(`[Douban API Cache] Error saving to cache for ${url}:`, e);
                        }
                        return jsonData; // Successful fetch and not rate-limited
                    } else if (isRateLimited) {
                        console.warn(`[MY_APP_DEBUG_DOUBAN] Douban rate limit detected for ${url} on attempt ${attempt + 1}.`, jsonData);
                        if (attempt < DOUBAN_API_MAX_RETRIES) {
                            const delayForThisAttempt = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_SINGLE_RETRY_DELAY_MS);
                            console.log(`[Douban API] Rate limit. Waiting ${delayForThisAttempt}ms before retry ${attempt + 2}.`);
                            await new Promise(resolve => setTimeout(resolve, delayForThisAttempt));
                            continue; // Go to next retry attempt
                        } else {
                            // Max retries reached for rate limit
                            if (url.includes('search_tags')) return { tags: [], error: jsonData };
                            return { subjects: [], error: jsonData }; 
                        }
                    } else { 
                         console.warn(`[MY_APP_DEBUG_DOUBAN] API response for ${url} (Attempt ${attempt+1}) did not contain 'subjects' or 'tags' key, and not a rate limit. Normalizing. Response:`, jsonData);
                        if (url.includes('search_tags')) return { tags: [] }; 
                        return { subjects: [] }; 
                    }
                } catch (parseError) {
                    console.error(`[MY_APP_DEBUG_DOUBAN] Failed to parse response body (Attempt ${attempt+1}) from Rust as JSON. Error:`, parseError, 'Body:', response.body);
                    // Don't retry on parse error, likely malformed response
                    if (url.includes('search_tags')) return { tags: [] };
                    return { subjects: [] }; 
                }
            } else { // HTTP error (e.g., 4xx, 5xx from Douban itself, not network error caught by outer catch)
                console.error(`[MY_APP_DEBUG_DOUBAN] Douban API request via Rust failed (Attempt ${attempt+1}). Status: ${response.status}, Body: ${response.body.substring(0, 200)}`);
                if (attempt < DOUBAN_API_MAX_RETRIES) { // Retry on server-side errors too
                    const delayForThisAttempt = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_SINGLE_RETRY_DELAY_MS);
                    console.log(`[Douban API] HTTP error. Waiting ${delayForThisAttempt}ms before retry ${attempt + 2}.`);
                    await new Promise(resolve => setTimeout(resolve, delayForThisAttempt));
                    continue;
                } else {
                    if (url.includes('search_tags')) return { tags: [] };
                    return { subjects: [] }; 
                }
            }
        } catch (error) { // Network error or error invoking tauri command
            console.error(`[MY_APP_DEBUG_DOUBAN] Error invoking make_http_request (Attempt ${attempt+1}) for URL:`, url, 'Error:', error);
            if (attempt < DOUBAN_API_MAX_RETRIES) {
                const delayForThisAttempt = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_SINGLE_RETRY_DELAY_MS);
                console.log(`[Douban API] Invoke/Network error. Waiting ${delayForThisAttempt}ms before retry ${attempt + 2}.`);
                await new Promise(resolve => setTimeout(resolve, delayForThisAttempt));
                continue; // Crucial for retry loop on network/invoke errors
            } else {
                // Max retries reached for network/invoke errors
                if (url.includes('search_tags')) return { tags: [] };
                return { subjects: [] }; 
            }
        }
    }
    // Fallback if all retries fail
    console.error(`[Douban API] All retries failed for ${url}.`);
    if (url.includes('search_tags')) return { tags: [], error: { msg: "All retries failed."} };
    return { subjects: [], error: { msg: "All retries failed."} };
}

// Depends on: fetchDoubanData (now in this file)
// Globals that will be in douban_logic.js: movieTags, defaultMovieTags, tvTags, defaultTvTags, doubanMovieTvCurrentSwitch
// UI function: renderDoubanTags (from douban_ui.js)
function fetchDoubanTags() {
    const movieTagsTarget = `https://movie.douban.com/j/search_tags?type=movie`;
    fetchDoubanData(movieTagsTarget)
        .then(data => {
            // These globals will be managed by douban_logic.js
            if (typeof movieTags !== 'undefined') {
                movieTags = (data && data.tags && Array.isArray(data.tags)) ? data.tags : [...defaultMovieTags];
                if (doubanMovieTvCurrentSwitch === 'movie' && typeof renderDoubanTags === 'function') renderDoubanTags();
            }
        })
        .catch(error => {
            console.error("获取豆瓣电影标签失败：", error);
            if (typeof movieTags !== 'undefined') {
                movieTags = [...defaultMovieTags]; 
                if (doubanMovieTvCurrentSwitch === 'movie' && typeof renderDoubanTags === 'function') renderDoubanTags();
            }
        });

    const tvTagsTarget = `https://movie.douban.com/j/search_tags?type=tv`;
    fetchDoubanData(tvTagsTarget)
       .then(data => {
            if (typeof tvTags !== 'undefined') {
                tvTags = (data && data.tags && Array.isArray(data.tags)) ? data.tags : [...defaultTvTags];
                if (doubanMovieTvCurrentSwitch === 'tv' && typeof renderDoubanTags === 'function') renderDoubanTags();
            }
        })
       .catch(error => {
            console.error("获取豆瓣电视剧标签失败：", error);
            if (typeof tvTags !== 'undefined') {
                tvTags = [...defaultTvTags]; 
                if (doubanMovieTvCurrentSwitch === 'tv' && typeof renderDoubanTags === 'function') renderDoubanTags();
            }
        });
}
