// ============ 聚合搜索 ============
// 所有启用源并发 search（music 类型），带 token 防陈旧响应覆盖（与视频聚合同思路）。

const musicSearchState = {
    token: 0,
    query: '',
    page: 1,           // 每源独立分页都翻到这一页
    results: [],       // 聚合后的曲目（已去重）
    pending: 0,        // 未返回的源数量
    searching: false
};

// 去重键：平台内唯一；跨平台同名同歌手的曲目不合并（各源音质/可用性不同）
function musicSearchDedupe(list, seen) {
    return list.filter(item => {
        const key = musicKey(item);
        if (!key || key === '|' || seen.has(key)) return false;
        seen.add(key);
        return !!(item.title && (item.id || item.hash));
    });
}

async function musicSearchStart(query) {
    const q = String(query || '').trim();
    if (!q) return;
    musicSearchState.token += 1;
    const token = musicSearchState.token;
    musicSearchState.query = q;
    musicSearchState.page = 1;
    musicSearchState.results = [];
    musicSearchState.searching = true;
    const sources = MusicPlugin.getEnabledMusicSources().filter(s => typeof s.search === 'function');
    musicSearchState.pending = sources.length;
    if (typeof musicSearchUI !== 'undefined' && musicSearchUI.onStart) musicSearchUI.onStart(q, sources.length);

    if (!sources.length) {
        musicSearchState.searching = false;
        if (typeof musicSearchUI !== 'undefined' && musicSearchUI.onDone) musicSearchUI.onDone(token);
        return;
    }

    await Promise.all(sources.map(async source => {
        try {
            const result = await source.search(q, 1, 'music');
            if (token !== musicSearchState.token) return;
            const list = musicSearchDedupe((result && result.data) || [], new Set(musicSearchState.results.map(musicKey)));
            list.forEach(item => { item.platform = item.platform || source.platform; });
            musicSearchState.results.push(...list);
        } catch (e) {
            if (token === musicSearchState.token && typeof showToast === 'function') {
                showToast('源「' + (source.platform || '?') + '」搜索失败：' + (e && e.message || e), 'warning');
            }
        } finally {
            if (token === musicSearchState.token) {
                musicSearchState.pending -= 1;
                if (typeof musicSearchUI !== 'undefined' && musicSearchUI.onPartial) musicSearchUI.onPartial(token);
            }
        }
    }));

    if (token === musicSearchState.token) {
        musicSearchState.searching = false;
        if (typeof musicSearchUI !== 'undefined' && musicSearchUI.onDone) musicSearchUI.onDone(token);
    }
}

// 加载下一页（每个源各自翻页，追加去重）
async function musicSearchLoadMore() {
    if (musicSearchState.searching || !musicSearchState.query) return;
    musicSearchState.searching = true;
    musicSearchState.page += 1;
    const token = musicSearchState.token;
    const page = musicSearchState.page;
    const sources = MusicPlugin.getEnabledMusicSources().filter(s => typeof s.search === 'function');
    await Promise.all(sources.map(async source => {
        try {
            const result = await source.search(musicSearchState.query, page, 'music');
            if (token !== musicSearchState.token) return;
            const list = musicSearchDedupe((result && result.data) || [], new Set(musicSearchState.results.map(musicKey)));
            list.forEach(item => { item.platform = item.platform || source.platform; });
            musicSearchState.results.push(...list);
        } catch (e) { /* 翻页失败静默 */ }
    }));
    if (token === musicSearchState.token) {
        musicSearchState.searching = false;
        if (typeof musicSearchUI !== 'undefined' && musicSearchUI.onPartial) musicSearchUI.onPartial(token);
        if (typeof musicSearchUI !== 'undefined' && musicSearchUI.onDone) musicSearchUI.onDone(token);
    }
}

// 播放整组结果：替换队列
function musicSearchPlayAll(startItem) {
    if (!musicSearchState.results.length) return;
    musicState.queue = musicSearchState.results.map(item => Object.assign({}, item));
    const startKey = startItem ? musicKey(startItem) : '';
    let idx = 0;
    if (startKey) {
        const found = musicState.queue.findIndex(item => musicKey(item) === startKey);
        if (found >= 0) idx = found;
    }
    saveMusicState();
    musicPlayerPlayAt(idx);
}
