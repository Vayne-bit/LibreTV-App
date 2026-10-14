// 搜索功能：多源并发，按源分组，结果逐个源渐进渲染

const YELLOW_TYPE_KEYWORDS = ['伦理片', '福利', '里番动漫', '门事件', '萝莉少女', '制服诱惑', '国产传媒', 'cosplay', '黑丝诱惑', '无码', '日本无码', '有码', '日本有码', 'SWAG', '网红主播', '色情片', '同性片', '福利视频', '福利片'];

const searchState = {
    token: 0,
    query: '',
    results: [],
    sources: [],
    pending: 0,
    activeSource: 'all'
};

function resolveSearchApi(apiId) {
    if (apiId.startsWith('custom_')) {
        const customApi = typeof getCustomApiInfo === 'function' ? getCustomApiInfo(apiId.replace('custom_', '')) : null;
        return customApi ? { base: customApi.url, name: customApi.name, apiUrl: customApi.url } : null;
    }
    const site = API_SITES[apiId];
    return site ? { base: site.api, name: site.name, apiUrl: undefined } : null;
}

async function fetchSearchList(url) {
    const response = await tauriInvoke('make_http_request', {
        options: {
            url,
            method: 'GET',
            headers: API_CONFIG.search.headers,
            timeout_secs: Math.floor(AGGREGATED_SEARCH_CONFIG.timeout / 1000) || 8
        }
    });
    if (!(response.status >= 200 && response.status < 300)) return { list: [], pagecount: 0 };
    try {
        const data = JSON.parse(response.body);
        return { list: Array.isArray(data && data.list) ? data.list : [], pagecount: (data && data.pagecount) || 1 };
    } catch (e) {
        return { list: [], pagecount: 0 };
    }
}

function filterSearchItems(items) {
    if (localStorage.getItem('yellowFilterEnabled') !== 'true') return items;
    return items.filter(item => !YELLOW_TYPE_KEYWORDS.some(keyword => (item.type_name || '').includes(keyword)));
}

async function searchSingleSource(apiId, query, token) {
    const api = resolveSearchApi(apiId);
    if (!api) return;
    const tag = item => ({ ...item, source_name: api.name, source_code: apiId, api_url: api.apiUrl });
    try {
        const first = await fetchSearchList(api.base + API_CONFIG.search.path + encodeURIComponent(query));
        if (token !== searchState.token) return;
        appendSearchResults(apiId, api.name, filterSearchItems(first.list.map(tag)));

        const extraPages = Math.min(first.pagecount, API_CONFIG.search.maxPages) - 1;
        if (extraPages > 0) {
            const pages = await Promise.all(Array.from({ length: extraPages }, (_, i) => {
                const url = api.base + API_CONFIG.search.pagePath
                    .replace('{query}', encodeURIComponent(query))
                    .replace('{page}', i + 2);
                return fetchSearchList(url).catch(() => ({ list: [] }));
            }));
            if (token !== searchState.token) return;
            appendSearchResults(apiId, api.name, filterSearchItems(pages.flatMap(page => page.list.map(tag))));
        }
    } catch (error) {
        console.warn(`API ${apiId} 搜索失败:`, error && error.message ? error.message : error);
    }
}

function appendSearchResults(sourceCode, sourceName, items) {
    if (!items.length) return;
    let source = searchState.sources.find(s => s.code === sourceCode);
    if (!source) {
        source = { code: sourceCode, name: sourceName, count: 0 };
        searchState.sources.push(source);
    }
    source.count += items.length;
    searchState.results.push(...items);
    renderSearchResults();
}

function searchRelevance(item) {
    const name = (item.vod_name || '').trim();
    if (name === searchState.query) return 0;
    if (name.startsWith(searchState.query)) return 1;
    if (name.includes(searchState.query)) return 2;
    return 3;
}

function renderSearchResults() {
    const resultsDiv = document.getElementById('results');
    const chips = document.getElementById('searchSourceChips');
    const count = document.getElementById('searchResultsCount');
    const status = document.getElementById('searchStatus');
    if (!resultsDiv) return;

    if (count) count.textContent = searchState.results.length;
    if (status) status.textContent = searchState.pending > 0 ? `正在搜索，还剩 ${searchState.pending} 个源…` : '';

    if (chips) {
        const all = `<button type="button" class="chip ${searchState.activeSource === 'all' ? 'active' : ''}" data-source="all">全部 ${searchState.results.length}</button>`;
        chips.innerHTML = all + searchState.sources.map(s =>
            `<button type="button" class="chip ${searchState.activeSource === s.code ? 'active' : ''}" data-source="${escapeHtml(s.code)}">${escapeHtml(s.name)} ${s.count}</button>`
        ).join('');
        chips.classList.toggle('hidden', searchState.sources.length === 0);
    }

    const visible = searchState.activeSource === 'all'
        ? searchState.results
        : searchState.results.filter(item => item.source_code === searchState.activeSource);

    if (visible.length === 0) {
        resultsDiv.innerHTML = searchState.pending > 0
            ? skeletonCardsHtml(12)
            : `<div class="empty-state">
                    <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5" stroke-linecap="round"/></svg>
                    <p>没有找到「${escapeHtml(searchState.query)}」相关的结果</p>
                    <span>换个关键词，或在设置里多勾选几个数据源试试</span>
               </div>`;
        return;
    }

    const sorted = [...visible].sort((a, b) => searchRelevance(a) - searchRelevance(b));
    const showSource = searchState.activeSource === 'all';
    resultsDiv.innerHTML = sorted.map(item => vodCardHtml(item, { showSource })).join('');
}

async function search(queryOverride) {
    if (window.isPasswordProtected && window.isPasswordVerified && window.isPasswordProtected() && !window.isPasswordVerified()) {
        if (typeof showPasswordModal === 'function') showPasswordModal();
        return;
    }
    const input = document.getElementById('searchInput');
    if (typeof queryOverride === 'string' && input) input.value = queryOverride;
    const query = (input ? input.value : '').trim();

    if (!query) {
        showToast('请输入搜索内容', 'info');
        return;
    }
    if (selectedAPIs.length === 0) {
        showToast('请至少选择一个数据源', 'warning');
        return;
    }
    if (input) input.blur();

    saveSearchHistory(query);
    if (typeof updateSearchRoute === 'function') updateSearchRoute(query);

    const token = ++searchState.token;
    Object.assign(searchState, { query, results: [], sources: [], pending: selectedAPIs.length, activeSource: 'all' });

    document.getElementById('resultsArea')?.classList.remove('hidden');
    document.getElementById('searchIdle')?.classList.add('hidden');
    renderSearchResults();

    await Promise.all(selectedAPIs.map(apiId =>
        searchSingleSource(apiId, query, token).finally(() => {
            if (token !== searchState.token) return;
            searchState.pending--;
            renderSearchResults();
        })
    ));
    if (token === searchState.token && typeof saveSearchCache === 'function') saveSearchCache();
}

function setupSearchResultEvents() {
    const chips = document.getElementById('searchSourceChips');
    if (chips) {
        chips.addEventListener('click', (e) => {
            const chip = e.target.closest('[data-source]');
            if (!chip) return;
            searchState.activeSource = chip.dataset.source;
            renderSearchResults();
        });
    }
}

function resetSearchResults() {
    searchState.token++;
    Object.assign(searchState, { query: '', results: [], sources: [], pending: 0, activeSource: 'all' });
    const resultsDiv = document.getElementById('results');
    if (resultsDiv) resultsDiv.innerHTML = '';
    document.getElementById('resultsArea')?.classList.add('hidden');
    document.getElementById('searchIdle')?.classList.remove('hidden');
}
