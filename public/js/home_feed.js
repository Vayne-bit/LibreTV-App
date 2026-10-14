// 首页：推荐（轮播 + 横向榜单） + 分类频道（筛选 + 无限滚动） + “更多”列表

const DOUBAN_OLD_API = 'https://movie.douban.com/j/search_subjects';
const DOUBAN_NEW_API = 'https://movie.douban.com/j/new_search_subjects';

const HOME_ROWS = [
    { key: 'hot_movie', title: '热门电影', type: 'movie', tag: '热门' },
    { key: 'hot_tv', title: '热门剧集', type: 'tv', tag: '热门' },
    { key: 'top_movie', title: '高分佳作', type: 'movie', tag: '豆瓣高分', sort: 'rank' },
    { key: 'cn_tv', title: '国产剧', type: 'tv', tag: '国产剧' },
    { key: 'anime', title: '热门动漫', type: 'tv', tag: '日本动画' },
    { key: 'variety', title: '热门综艺', type: 'tv', tag: '综艺' },
    { key: 'new_movie', title: '最新电影', type: 'movie', tag: '最新', sort: 'time' },
    { key: 'us_tv', title: '美剧', type: 'tv', tag: '美剧' },
    { key: 'kr_tv', title: '韩剧', type: 'tv', tag: '韩剧' }
];

const HOME_CHANNELS = [
    { key: 'recommend', label: '推荐' },
    {
        key: 'movie', label: '电影', tags: '电影', fallback: { type: 'movie', tag: '热门' },
        genres: ['剧情', '喜剧', '动作', '爱情', '科幻', '动画', '悬疑', '惊悚', '恐怖', '犯罪', '奇幻', '冒险', '战争', '历史', '武侠', '家庭', '传记', '灾难']
    },
    {
        key: 'tv', label: '电视剧', tags: '电视剧', fallback: { type: 'tv', tag: '热门' },
        genres: ['剧情', '爱情', '喜剧', '悬疑', '犯罪', '古装', '武侠', '家庭', '奇幻', '科幻', '惊悚', '历史', '战争', '动作', '传记']
    },
    {
        key: 'anime', label: '动漫', tags: '动画', fallback: { type: 'tv', tag: '日本动画' },
        genres: ['剧情', '喜剧', '冒险', '奇幻', '科幻', '动作', '爱情', '悬疑', '运动', '音乐', '儿童', '家庭']
    },
    {
        key: 'variety', label: '综艺', tags: '综艺', fallback: { type: 'tv', tag: '综艺' },
        genres: ['真人秀', '脱口秀', '音乐', '歌舞']
    },
    {
        key: 'documentary', label: '纪录片', tags: '纪录片', fallback: { type: 'tv', tag: '纪录片' },
        genres: ['历史', '传记', '运动', '音乐', '战争', '犯罪']
    }
];

const CHANNEL_COUNTRIES = ['中国大陆', '美国', '中国香港', '中国台湾', '日本', '韩国', '英国', '法国', '德国', '泰国', '印度', '西班牙'];

const CHANNEL_SORTS = [
    { value: 'U', label: '近期热门' },
    { value: 'T', label: '标记最多' },
    { value: 'S', label: '评分最高' },
    { value: 'R', label: '最新上映' }
];

function channelYearOptions() {
    const year = new Date().getFullYear();
    const options = [];
    for (let y = year; y > year - 4; y--) options.push({ value: `${y},${y}`, label: String(y) });
    return options.concat([
        { value: '2020,2029', label: '2020年代' },
        { value: '2010,2019', label: '2010年代' },
        { value: '2000,2009', label: '2000年代' },
        { value: '1990,1999', label: '90年代' },
        { value: '1900,1989', label: '更早' }
    ]);
}

const CHANNEL_PAGE_SIZE = 20;
const LIST_PAGE_SIZE = 24;

const homeState = {
    initialized: false,
    channel: 'recommend',
    rowsObserver: null,
    bannerTimer: null,
    channels: {},
    channelObserver: null,
    list: null,
    listObserver: null
};

function isDoubanEnabled() {
    return localStorage.getItem('doubanEnabled') !== 'false';
}

function oldDoubanUrl({ type, tag, sort = 'recommend' }, start, limit) {
    const params = new URLSearchParams({ type, tag, sort, page_limit: String(limit), page_start: String(start) });
    return `${DOUBAN_OLD_API}?${params.toString()}`;
}

async function fetchDoubanSubjects(url) {
    try {
        const data = await fetchDoubanData(url);
        return { subjects: Array.isArray(data && data.subjects) ? data.subjects : [], error: data && data.error };
    } catch (e) {
        return { subjects: [], error: e };
    }
}

function normalizeSubject(subject) {
    const casts = Array.isArray(subject.casts) ? subject.casts.slice(0, 2).join(' ') : '';
    return { ...subject, subtitle: subject.subtitle || casts };
}

// ============ Channel tabs ============

function renderChannelTabs() {
    const tabs = document.getElementById('channelTabs');
    if (!tabs) return;
    tabs.innerHTML = HOME_CHANNELS.map(c =>
        `<button type="button" data-channel="${c.key}" class="${c.key === homeState.channel ? 'active' : ''}" role="tab">${c.label}</button>`
    ).join('');
    tabs.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-channel]');
        if (!btn) return;
        const key = btn.dataset.channel;
        replaceHash(key === 'recommend' ? '#home' : `#home/${key}`);
    });
}

function initHomeFeed() {
    if (homeState.initialized) return;
    homeState.initialized = true;
    renderChannelTabs();
    setupRowArrows(document.getElementById('homeRows'));
    applyDoubanEnabledState();
}

function applyDoubanEnabledState() {
    const enabled = isDoubanEnabled();
    document.getElementById('doubanDisabledTip')?.classList.toggle('hidden', enabled);
    document.getElementById('channelTabs')?.classList.toggle('hidden', !enabled);
    document.getElementById('homeRows')?.classList.toggle('hidden', !enabled);
    if (!enabled) {
        document.getElementById('homeBanner')?.classList.add('hidden');
        document.getElementById('homeChannel')?.classList.add('hidden');
        document.getElementById('homeRecommend')?.classList.remove('hidden');
        stopBannerTimer();
        return;
    }
    showHomeChannel(homeState.channel, true);
}

function refreshHomeFeed() {
    if (!homeState.initialized) return;
    const rows = document.getElementById('homeRows');
    if (rows) rows.innerHTML = '';
    if (homeState.rowsObserver) { homeState.rowsObserver.disconnect(); homeState.rowsObserver = null; }
    const banner = document.getElementById('homeBanner');
    if (banner) { banner.innerHTML = ''; banner.dataset.loaded = ''; }
    homeState.channels = {};
    applyDoubanEnabledState();
}

function showHomeChannel(key, force = false) {
    if (!HOME_CHANNELS.some(c => c.key === key)) key = 'recommend';
    const changed = homeState.channel !== key;
    homeState.channel = key;
    document.querySelectorAll('#channelTabs [data-channel]').forEach(btn => btn.classList.toggle('active', btn.dataset.channel === key));
    const activeTab = document.querySelector(`#channelTabs [data-channel="${key}"]`);
    if (activeTab) activeTab.scrollIntoView({ block: 'nearest', inline: 'center' });
    if (!isDoubanEnabled()) return;

    const recommend = document.getElementById('homeRecommend');
    const channel = document.getElementById('homeChannel');
    if (key === 'recommend') {
        recommend.classList.remove('hidden');
        channel.classList.add('hidden');
        renderRecommend();
        startBannerTimer();
    } else {
        stopBannerTimer();
        recommend.classList.add('hidden');
        channel.classList.remove('hidden');
        if (changed || force || !channel.dataset.channel) renderChannel(key);
    }
}

// ============ Recommend: banner + rows ============

function renderRecommend() {
    const rows = document.getElementById('homeRows');
    if (!rows || rows.childElementCount > 0) return;

    rows.innerHTML = HOME_ROWS.map(row => `
        <section class="feed-row" data-row="${row.key}">
            <div class="row-head">
                <h2 class="row-title">${row.title}</h2>
                <button type="button" class="row-more" data-go="list/${row.key}">更多
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
                </button>
            </div>
            <div class="row-body">
                <button type="button" class="row-arrow prev" data-dir="-1" aria-label="向左">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M15 6l-6 6 6 6"/></svg>
                </button>
                <div class="row-track">${skeletonCardsHtml(8)}</div>
                <button type="button" class="row-arrow next" data-dir="1" aria-label="向右">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>
                </button>
            </div>
        </section>`).join('');

    homeState.rowsObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (!entry.isIntersecting) return;
            observer.unobserve(entry.target);
            loadHomeRow(entry.target);
        });
    }, { rootMargin: '300px 0px' });
    rows.querySelectorAll('.feed-row').forEach(section => homeState.rowsObserver.observe(section));

    loadBanner();
}

async function loadHomeRow(section) {
    const row = HOME_ROWS.find(r => r.key === section.dataset.row);
    const track = section.querySelector('.row-track');
    if (!row || !track) return;
    const { subjects } = await fetchDoubanSubjects(oldDoubanUrl(row, 0, 18));
    if (subjects.length === 0) {
        track.outerHTML = `<div class="row-error">暂时没有加载到内容 <button type="button" class="text-btn" data-retry-row="${row.key}">重试</button></div>`;
        return;
    }
    track.innerHTML = subjects.map(s => doubanCardHtml(normalizeSubject(s))).join('');
}

function setupRowArrows(container) {
    if (!container) return;
    container.addEventListener('click', (e) => {
        const arrow = e.target.closest('.row-arrow');
        if (arrow) {
            const track = arrow.parentElement.querySelector('.row-track');
            if (track) track.scrollBy({ left: Number(arrow.dataset.dir) * track.clientWidth * 0.9, behavior: 'smooth' });
            return;
        }
        const retry = e.target.closest('[data-retry-row]');
        if (retry) {
            const section = retry.closest('.feed-row');
            retry.parentElement.outerHTML = `<div class="row-track">${skeletonCardsHtml(8)}</div>`;
            loadHomeRow(section);
        }
    });
}

async function loadBanner() {
    const banner = document.getElementById('homeBanner');
    if (!banner || banner.dataset.loaded) return;
    banner.dataset.loaded = '1';
    const [movies, tvs] = await Promise.all([
        fetchDoubanSubjects(oldDoubanUrl(HOME_ROWS[0], 0, 18)),
        fetchDoubanSubjects(oldDoubanUrl(HOME_ROWS[1], 0, 18))
    ]);
    const items = [];
    for (let i = 0; i < 4; i++) {
        if (movies.subjects[i]) items.push({ ...movies.subjects[i], kind: '电影' });
        if (tvs.subjects[i]) items.push({ ...tvs.subjects[i], kind: '剧集' });
    }
    if (items.length === 0) { banner.dataset.loaded = ''; return; }

    banner.innerHTML = `
        <div class="banner-track">
            ${items.map(item => {
                const cover = posterSrc(item.cover, 'm');
                const rate = item.rate && item.rate !== '0' ? item.rate : '';
                return `<button type="button" class="banner-slide" data-card="douban" data-title="${escapeHtml(item.title)}">
                    <div class="banner-bg" style="background-image:url('${escapeHtml(cover)}')"></div>
                    <div class="banner-poster">${posterImgHtml(item.cover, item.title, '', 'm')}</div>
                    <div class="banner-info">
                        <span class="banner-tag">热门${item.kind}</span>
                        <div class="banner-title">${escapeHtml(item.title)}</div>
                        <div class="banner-meta">${rate ? `<b>${escapeHtml(rate)}</b>豆瓣评分` : (item.episodes_info ? escapeHtml(item.episodes_info) : '')}</div>
                        <span class="btn-primary banner-cta">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>
                            搜索播放
                        </span>
                    </div>
                </button>`;
            }).join('')}
        </div>
        <div class="banner-dots">${items.map((_, i) => `<i class="${i === 0 ? 'active' : ''}"></i>`).join('')}</div>`;
    banner.classList.remove('hidden');

    const track = banner.querySelector('.banner-track');
    const dots = banner.querySelectorAll('.banner-dots i');
    track.addEventListener('scroll', () => {
        const index = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
        dots.forEach((dot, i) => dot.classList.toggle('active', i === index));
    }, { passive: true });
    ['pointerdown', 'mouseenter', 'touchstart'].forEach(type => track.addEventListener(type, stopBannerTimer, { passive: true }));
    ['mouseleave', 'touchend'].forEach(type => track.addEventListener(type, startBannerTimer, { passive: true }));
    startBannerTimer();
}

function startBannerTimer() {
    stopBannerTimer();
    homeState.bannerTimer = setInterval(() => {
        const track = document.querySelector('#homeBanner .banner-track');
        if (!track || !track.offsetParent) return;
        const count = track.children.length;
        const index = Math.round(track.scrollLeft / Math.max(track.clientWidth, 1));
        track.scrollTo({ left: ((index + 1) % count) * track.clientWidth, behavior: 'smooth' });
    }, 5000);
}

function stopBannerTimer() {
    if (homeState.bannerTimer) clearInterval(homeState.bannerTimer);
    homeState.bannerTimer = null;
}

// ============ Channel pages ============

function getChannelState(key) {
    if (!homeState.channels[key]) {
        homeState.channels[key] = { genre: '', country: '', year: '', sort: 'U', start: 0, items: [], done: false, loading: false, mode: 'new', token: 0 };
    }
    return homeState.channels[key];
}

function renderChannel(key) {
    const channel = HOME_CHANNELS.find(c => c.key === key);
    const state = getChannelState(key);
    const root = document.getElementById('homeChannel');
    root.dataset.channel = key;

    const line = (name, options, current) => `
        <div class="filter-line" data-filter="${name}">
            ${options.map(o => `<button type="button" data-value="${escapeHtml(o.value)}" class="${o.value === current ? 'active' : ''}">${escapeHtml(o.label)}</button>`).join('')}
        </div>`;
    const all = [{ value: '', label: '全部' }];
    document.getElementById('channelFilters').innerHTML = [
        line('sort', CHANNEL_SORTS, state.sort),
        line('genre', all.concat(channel.genres.map(g => ({ value: g, label: g }))), state.genre),
        line('country', all.concat(CHANNEL_COUNTRIES.map(c => ({ value: c, label: c }))), state.country),
        line('year', all.concat(channelYearOptions()), state.year)
    ].join('');

    const grid = document.getElementById('channelGrid');
    grid.innerHTML = state.items.map(s => doubanCardHtml(normalizeSubject(s))).join('');
    updateChannelHint(state);
    updateChannelSentinel(state);
    if (state.items.length === 0) loadChannelPage(key);
    observeChannelSentinel();
}

function updateChannelHint(state) {
    const hint = document.getElementById('channelHint');
    if (!hint) return;
    hint.classList.toggle('hidden', state.mode !== 'old');
    hint.textContent = '豆瓣筛选接口暂时不可用，已为你展示热门内容';
}

function updateChannelSentinel(state) {
    const sentinel = document.getElementById('channelSentinel');
    if (!sentinel) return;
    if (state.loading) sentinel.innerHTML = '<div class="spinner"></div>';
    else if (state.done) sentinel.textContent = state.items.length ? '已经到底啦' : '没有符合条件的内容';
    else sentinel.textContent = '';
}

function buildChannelUrl(channel, state) {
    if (state.mode === 'old') return oldDoubanUrl(channel.fallback, state.start, CHANNEL_PAGE_SIZE);
    const params = new URLSearchParams({ sort: state.sort, range: '0,10', tags: channel.tags, start: String(state.start) });
    if (state.genre) params.set('genres', state.genre);
    if (state.country) params.set('countries', state.country);
    if (state.year) params.set('year_range', state.year);
    return `${DOUBAN_NEW_API}?${params.toString()}`;
}

async function loadChannelPage(key) {
    const channel = HOME_CHANNELS.find(c => c.key === key);
    const state = getChannelState(key);
    if (!channel || state.loading || state.done) return;
    state.loading = true;
    const token = ++state.token;
    const isCurrent = () => homeState.channel === key && token === state.token;
    if (isCurrent()) {
        updateChannelSentinel(state);
        if (state.items.length === 0) document.getElementById('channelGrid').innerHTML = skeletonCardsHtml(12);
    }

    let { subjects, error } = await fetchDoubanSubjects(buildChannelUrl(channel, state));
    if (token !== state.token) return;
    if (state.mode === 'new' && state.start === 0 && subjects.length === 0 && error) {
        state.mode = 'old';
        ({ subjects } = await fetchDoubanSubjects(buildChannelUrl(channel, state)));
        if (token !== state.token) return;
    }

    state.loading = false;
    state.items.push(...subjects);
    state.start += subjects.length;
    if (subjects.length < CHANNEL_PAGE_SIZE / 2) state.done = true;

    if (!isCurrent()) return;
    const grid = document.getElementById('channelGrid');
    if (state.items.length === subjects.length) grid.innerHTML = '';
    grid.insertAdjacentHTML('beforeend', subjects.map(s => doubanCardHtml(normalizeSubject(s))).join(''));
    updateChannelHint(state);
    updateChannelSentinel(state);
    requestAnimationFrame(checkChannelSentinel);
}

function observeChannelSentinel() {
    if (homeState.channelObserver) return;
    homeState.channelObserver = new IntersectionObserver((entries) => {
        if (entries.some(e => e.isIntersecting)) checkChannelSentinel();
    }, { rootMargin: '600px 0px' });
    homeState.channelObserver.observe(document.getElementById('channelSentinel'));
}

function checkChannelSentinel() {
    const key = homeState.channel;
    const sentinel = document.getElementById('channelSentinel');
    if (key === 'recommend' || !sentinel || !sentinel.offsetParent) return;
    const rect = sentinel.getBoundingClientRect();
    if (rect.top < window.innerHeight + 600) loadChannelPage(key);
}

function setupChannelFilters() {
    const filters = document.getElementById('channelFilters');
    if (!filters) return;
    filters.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-value]');
        const line = e.target.closest('[data-filter]');
        if (!btn || !line) return;
        const state = getChannelState(homeState.channel);
        state[line.dataset.filter] = btn.dataset.value;
        Object.assign(state, { start: 0, items: [], done: false, loading: false, mode: 'new' });
        state.token++;
        line.querySelectorAll('[data-value]').forEach(b => b.classList.toggle('active', b === btn));
        document.getElementById('channelGrid').innerHTML = '';
        loadChannelPage(homeState.channel);
    });
}

// ============ "更多" list page ============

function showListPage(key) {
    const row = HOME_ROWS.find(r => r.key === key) || HOME_ROWS[0];
    const titleEl = document.getElementById('listTitle');
    if (titleEl) titleEl.textContent = row.title;
    if (!homeState.list || homeState.list.key !== row.key) {
        homeState.list = { key: row.key, start: 0, done: false, loading: false, token: (homeState.list ? homeState.list.token + 1 : 0) };
        document.getElementById('listGrid').innerHTML = skeletonCardsHtml(12);
        loadListPage();
    }
    if (!homeState.listObserver) {
        homeState.listObserver = new IntersectionObserver((entries) => {
            if (entries.some(e => e.isIntersecting)) loadListPage();
        }, { rootMargin: '600px 0px' });
        homeState.listObserver.observe(document.getElementById('listSentinel'));
    }
}

async function loadListPage() {
    const list = homeState.list;
    if (!list || list.loading || list.done) return;
    const row = HOME_ROWS.find(r => r.key === list.key);
    list.loading = true;
    const token = list.token;
    const sentinel = document.getElementById('listSentinel');
    sentinel.innerHTML = '<div class="spinner"></div>';

    const { subjects } = await fetchDoubanSubjects(oldDoubanUrl(row, list.start, LIST_PAGE_SIZE));
    if (homeState.list !== list || token !== list.token) return;
    list.loading = false;
    const grid = document.getElementById('listGrid');
    if (list.start === 0) grid.innerHTML = '';
    grid.insertAdjacentHTML('beforeend', subjects.map(s => doubanCardHtml(normalizeSubject(s))).join(''));
    list.start += subjects.length;
    if (subjects.length < LIST_PAGE_SIZE / 2) list.done = true;
    sentinel.textContent = list.done ? (list.start ? '已经到底啦' : '暂时没有内容') : '';

    const rect = sentinel.getBoundingClientRect();
    if (!list.done && sentinel.offsetParent && rect.top < window.innerHeight + 600) loadListPage();
}

// ============ Hot search ============

async function loadHotSearch() {
    const box = document.getElementById('hotSearch');
    const listEl = document.getElementById('hotSearchList');
    if (!box || !listEl || listEl.childElementCount > 0 || !isDoubanEnabled()) return;
    const [movies, tvs] = await Promise.all([
        fetchDoubanSubjects(oldDoubanUrl(HOME_ROWS[0], 0, 18)),
        fetchDoubanSubjects(oldDoubanUrl(HOME_ROWS[1], 0, 18))
    ]);
    const titles = [];
    for (let i = 0; i < 18 && titles.length < 12; i++) {
        [tvs.subjects[i], movies.subjects[i]].forEach(s => {
            if (s && s.title && !titles.includes(s.title) && titles.length < 12) titles.push(s.title);
        });
    }
    if (titles.length === 0) return;
    listEl.innerHTML = titles.map((t, i) =>
        `<button type="button" class="hot-item" data-hot="${escapeHtml(t)}"><span class="hot-rank">${i + 1}</span><span>${escapeHtml(t)}</span></button>`
    ).join('');
    box.classList.remove('hidden');
}

document.addEventListener('DOMContentLoaded', setupChannelFilters);
