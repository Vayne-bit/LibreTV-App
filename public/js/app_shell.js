// App shell: hash routing (#home[/channel], #search?q=, #list/<row>, #history[/fav], #settings),
// navigation, global card clicks and per-route scroll restore.

const SHELL_PAGES = ['home', 'search', 'list', 'history', 'settings'];
const SCROLL_STORE_KEY = 'shellScrollPositions';

const shellState = {
    routeKey: '',
    navStack: [],
    replacing: false,
    initialized: false
};

function parseRoute(hash = window.location.hash) {
    const raw = decodeURI(hash.replace(/^#/, '')) || 'home';
    const [path, query = ''] = raw.split('?');
    const parts = path.split('/');
    const page = SHELL_PAGES.includes(parts[0]) ? parts[0] : 'home';
    return { page, sub: parts[1] || '', params: new URLSearchParams(query), key: raw };
}

function readScrollStore() {
    try { return JSON.parse(sessionStorage.getItem(SCROLL_STORE_KEY) || '{}'); } catch (e) { return {}; }
}

function saveScrollPosition() {
    if (!shellState.routeKey) return;
    const store = readScrollStore();
    store[shellState.routeKey] = window.scrollY;
    try { sessionStorage.setItem(SCROLL_STORE_KEY, JSON.stringify(store)); } catch (e) { /* ignore */ }
}

function restoreScrollPosition(key) {
    const y = readScrollStore()[key] || 0;
    window.scrollTo(0, y);
    if (y > 0) {
        setTimeout(() => window.scrollTo(0, y), 300);
        setTimeout(() => window.scrollTo(0, y), 900);
    }
}

function renderRoute() {
    const route = parseRoute();
    saveScrollPosition();
    shellState.routeKey = route.key;

    SHELL_PAGES.forEach(page => {
        document.getElementById(`page-${page}`)?.classList.toggle('hidden', page !== route.page);
    });
    const navPage = route.page === 'list' ? 'home' : route.page;
    document.querySelectorAll('#bottomNav .nav-item, #sideRail .nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.page === navPage);
    });
    if (route.page !== 'home' && typeof stopBannerTimer === 'function') stopBannerTimer();

    switch (route.page) {
        case 'home':
            initHomeFeed();
            showHomeChannel(route.sub || 'recommend');
            break;
        case 'search':
            enterSearchPage(route.params.get('q') || '');
            break;
        case 'list':
            showListPage(route.sub);
            break;
        case 'history':
            showMineTab(route.sub === 'fav' ? 'fav' : 'history');
            break;
    }
    restoreScrollPosition(route.key);
}

function enterSearchPage(query) {
    const input = document.getElementById('searchInput');
    renderSearchHistory();
    loadHotSearch();
    if (query) {
        if (input) input.value = query;
        updateSearchClearButton();
        if (query !== searchState.query && !restoreSearchCache(query)) search(query);
        return;
    }
    if (searchState.query) resetSearchResults();
    if (input) {
        input.value = '';
        updateSearchClearButton();
        if (shellState.initialized) setTimeout(() => input.focus(), 50);
    }
}

function updateSearchRoute(query) {
    const target = `#search?q=${encodeURIComponent(query)}`;
    if (window.location.hash === target) return;
    if (parseRoute().page === 'search') {
        history.replaceState(history.state, '', target);
        shellState.routeKey = parseRoute(target).key;
        shellState.navStack[shellState.navStack.length - 1] = target;
    } else {
        window.location.hash = target;
    }
}

function replaceHash(target) {
    if (window.location.hash === target) return;
    shellState.replacing = true;
    window.location.replace(target);
}

function onHashChange() {
    const hash = window.location.hash || '#home';
    const stack = shellState.navStack;
    if (shellState.replacing) {
        shellState.replacing = false;
        stack[stack.length - 1] = hash;
    } else if (stack.length > 1 && stack[stack.length - 2] === hash) {
        stack.pop();
    } else if (stack[stack.length - 1] !== hash) {
        stack.push(hash);
    }
    renderRoute();
}

function goBackInApp() {
    if (shellState.navStack.length > 1) history.back();
    else replaceHash('#home');
}

function navigateToPage(page) {
    const current = parseRoute();
    const target = `#${page}`;
    if (current.page === page && (page !== 'home' || !current.sub)) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return;
    }
    if (page === 'home') {
        const stack = shellState.navStack;
        const prev = stack[stack.length - 2];
        if (prev && parseRoute(prev).page === 'home') history.back();
        else replaceHash(target);
        return;
    }
    // Tabs other than home replace each other so Back always returns to home first.
    if (current.page === 'home') window.location.hash = target;
    else replaceHash(target);
}

function updateSearchClearButton() {
    const input = document.getElementById('searchInput');
    document.getElementById('searchClearBtn')?.classList.toggle('hidden', !(input && input.value));
}

function saveSearchCache() {
    try {
        const keep = ['vod_id', 'vod_name', 'vod_pic', 'vod_remarks', 'type_name', 'vod_year', 'source_name', 'source_code', 'api_url'];
        const results = searchState.results.map(item => Object.fromEntries(keep.map(k => [k, item[k]])));
        sessionStorage.setItem('searchCache', JSON.stringify({ query: searchState.query, results, sources: searchState.sources }));
    } catch (e) { /* quota exceeded: skip caching */ }
}

function restoreSearchCache(query) {
    try {
        const cache = JSON.parse(sessionStorage.getItem('searchCache') || 'null');
        if (!cache || cache.query !== query || !Array.isArray(cache.results)) return false;
        searchState.token++;
        Object.assign(searchState, { query, results: cache.results, sources: cache.sources || [], pending: 0, activeSource: 'all' });
        document.getElementById('resultsArea')?.classList.remove('hidden');
        document.getElementById('searchIdle')?.classList.add('hidden');
        renderSearchResults();
        return true;
    } catch (e) {
        return false;
    }
}

function setupShellEvents() {
    document.querySelectorAll('#bottomNav .nav-item, #sideRail .nav-item').forEach(item => {
        item.addEventListener('click', () => navigateToPage(item.dataset.page));
    });

    document.addEventListener('click', (e) => {
        const card = e.target.closest('[data-card]');
        if (card) {
            if (card.dataset.card === 'douban') {
                window.location.hash = `#search?q=${encodeURIComponent(card.dataset.title || '')}`;
            } else if (card.dataset.card === 'vod') {
                showDetails(card.dataset.id, card.dataset.title, card.dataset.source);
            } else if (card.dataset.card === 'vodgroup') {
                openSearchGroup(card.dataset.key, card.dataset.title);
            }
            return;
        }
        const go = e.target.closest('[data-go]');
        if (go) { window.location.hash = `#${go.dataset.go}`; return; }
        if (e.target.closest('[data-back]')) { goBackInApp(); return; }
        const hot = e.target.closest('[data-hot]');
        if (hot) search(hot.dataset.hot);
    });

    const input = document.getElementById('searchInput');
    input?.addEventListener('input', updateSearchClearButton);
    document.getElementById('searchClearBtn')?.addEventListener('click', () => {
        if (!input) return;
        input.value = '';
        updateSearchClearButton();
        input.focus();
    });

    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('pagehide', saveScrollPosition);
}

function initAppShell() {
    if (history.state && history.state.sheet) history.replaceState(null, '');
    setupShellEvents();
    setupDetailSheet();
    setupSearchResultEvents();
    shellState.navStack = [window.location.hash || '#home'];
    renderRoute();
    shellState.initialized = true;
}
