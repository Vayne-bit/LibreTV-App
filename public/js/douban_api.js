// This file will handle all interactions with the Douban API.
// Functions to be moved here include:
// - fetchDoubanData
// - fetchDoubanTags (or its equivalent using the new API)
// - New functions to construct URLs and fetch data from the new Douban filter API (/j/new_search_subjects)

console.log('douban_api.js loaded');

const DOUBAN_API_CACHE_DURATION_MS = 30 * 60 * 1000;
const DOUBAN_API_STALE_MAX_MS = 24 * 60 * 60 * 1000;
const DOUBAN_API_CACHE_PREFIX = 'douban_cache_v1:';
const DOUBAN_API_CACHE_MAX_ENTRIES = 80;
const DOUBAN_API_MAX_RETRIES = 2;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_SINGLE_RETRY_DELAY_MS = 4000;

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

const doubanInflightRequests = new Map();

function readDoubanCache(url) {
    try {
        const item = JSON.parse(localStorage.getItem(DOUBAN_API_CACHE_PREFIX + url) || 'null');
        return item && item.timestamp && item.data ? item : null;
    } catch (e) {
        return null;
    }
}

function pruneDoubanCache(maxEntries) {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(DOUBAN_API_CACHE_PREFIX)) keys.push(key);
    }
    if (keys.length <= maxEntries) return;
    const entries = keys.map(key => {
        let timestamp = 0;
        try { timestamp = JSON.parse(localStorage.getItem(key)).timestamp || 0; } catch (e) { /* corrupted entry sorts first */ }
        return { key, timestamp };
    });
    entries.sort((a, b) => a.timestamp - b.timestamp);
    entries.slice(0, entries.length - maxEntries).forEach(entry => localStorage.removeItem(entry.key));
}

function writeDoubanCache(url, data) {
    const value = JSON.stringify({ timestamp: Date.now(), data });
    try {
        localStorage.setItem(DOUBAN_API_CACHE_PREFIX + url, value);
        pruneDoubanCache(DOUBAN_API_CACHE_MAX_ENTRIES);
    } catch (e) {
        // Storage full: drop the whole Douban cache so history and settings keep working.
        pruneDoubanCache(0);
    }
}

// Common function to fetch data from Douban, used by both old and new API calls.
function fetchDoubanData(url) {
    const cached = readDoubanCache(url);
    if (cached && Date.now() - cached.timestamp < DOUBAN_API_CACHE_DURATION_MS) return Promise.resolve(cached.data);
    if (doubanInflightRequests.has(url)) return doubanInflightRequests.get(url);
    const request = requestDoubanData(url, cached).finally(() => doubanInflightRequests.delete(url));
    doubanInflightRequests.set(url, request);
    return request;
}

async function requestDoubanData(url, cached) {
    const fallback = (error) => {
        if (cached && Date.now() - cached.timestamp < DOUBAN_API_STALE_MAX_MS) return cached.data;
        return url.includes('search_tags') ? { tags: [], error } : { subjects: [], error };
    };
    if (!isTauriApp()) return fallback({ msg: 'Tauri API unavailable' });

    let lastError = null;
    for (let attempt = 0; attempt <= DOUBAN_API_MAX_RETRIES; attempt++) {
        if (attempt > 0) {
            const delay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt - 1), MAX_SINGLE_RETRY_DELAY_MS);
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        let response;
        try {
            response = await tauriInvoke('make_http_request', {
                options: {
                    url,
                    method: 'GET',
                    headers: {
                        'User-Agent': getRandomUserAgent(),
                        'Referer': 'https://movie.douban.com/',
                        'Accept': 'application/json, text/plain, */*',
                        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                        'X-Requested-With': 'XMLHttpRequest'
                    },
                    timeout_secs: 15
                }
            });
        } catch (error) {
            lastError = { msg: error && error.error ? error.error : String(error) };
            continue;
        }

        if (response.status >= 400 && response.status < 500 && response.status !== 429) {
            return fallback({ msg: `HTTP ${response.status}` });
        }
        if (!(response.status >= 200 && response.status < 300)) {
            lastError = { msg: `HTTP ${response.status}` };
            continue;
        }

        let jsonData;
        try {
            jsonData = JSON.parse(response.body);
        } catch (e) {
            return fallback({ msg: 'Invalid JSON from Douban' });
        }
        if (url.startsWith(DOUBAN_NEW_SEARCH_API_BASE) && Array.isArray(jsonData.data) && typeof jsonData.subjects === 'undefined') {
            jsonData = { subjects: jsonData.data };
        }
        if (jsonData.msg && String(jsonData.msg).includes('检测到有异常请求')) {
            lastError = jsonData;
            continue;
        }

        const hasData = typeof jsonData.subjects !== 'undefined' ||
            typeof jsonData.tags !== 'undefined' ||
            (url.startsWith('https://movie.douban.com/j/chart/top_list') && Array.isArray(jsonData));
        if (!hasData) return fallback();

        writeDoubanCache(url, jsonData);
        return jsonData;
    }
    return fallback(lastError || { msg: 'All retries failed.' });
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
