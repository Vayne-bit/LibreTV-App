// 收藏 / 追剧：本地存储、"我的 → 收藏"列表，打开列表时检查新集

const FAVORITES_KEY = 'favorites';
const FAVORITE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
const FAVORITE_CHECK_CONCURRENCY = 3;

const favoritesState = {
    managing: false,
    checking: false
};

function getFavorites() {
    try {
        const list = JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]');
        return Array.isArray(list) ? list : [];
    } catch (e) {
        return [];
    }
}

function saveFavorites(list) {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(list));
}

function findFavorite(list, sourceCode, id) {
    return list.find(item => item.sourceCode === sourceCode && String(item.id) === String(id));
}

function isFavorite(sourceCode, id) {
    return !!findFavorite(getFavorites(), sourceCode, id);
}

function removeFavorite(sourceCode, id) {
    saveFavorites(getFavorites().filter(item => !(item.sourceCode === sourceCode && String(item.id) === String(id))));
}

// 返回 true 表示已加入收藏，false 表示已取消收藏
function toggleFavorite(entry) {
    if (isFavorite(entry.sourceCode, entry.id)) {
        removeFavorite(entry.sourceCode, entry.id);
        return false;
    }
    const now = Date.now();
    const count = entry.episodeCount || 0;
    const list = getFavorites();
    list.push({
        id: String(entry.id),
        sourceCode: entry.sourceCode,
        sourceName: entry.sourceName || '',
        title: entry.title || '',
        cover: entry.cover || '',
        type: entry.type || '',
        year: entry.year || '',
        remarks: entry.remarks || '',
        episodeCount: count,
        seenCount: count,
        hasUpdate: false,
        addedAt: now,
        checkedAt: now
    });
    saveFavorites(list);
    return true;
}

function markFavoriteSeen(sourceCode, id, count, remarks) {
    const list = getFavorites();
    const item = findFavorite(list, sourceCode, id);
    if (!item) return;
    item.episodeCount = count;
    item.seenCount = count;
    item.hasUpdate = false;
    item.checkedAt = Date.now();
    if (remarks) item.remarks = remarks;
    saveFavorites(list);
}

function recordFavoriteCheck(sourceCode, id, count, remarks) {
    const list = getFavorites();
    const item = findFavorite(list, sourceCode, id);
    if (!item) return;
    item.checkedAt = Date.now();
    if (typeof count === 'number') {
        if (count > (item.seenCount || 0)) item.hasUpdate = true;
        item.episodeCount = count;
        if (remarks) item.remarks = remarks;
    }
    saveFavorites(list);
}

async function checkFavoriteUpdates() {
    if (favoritesState.checking || typeof fetchVodDetail !== 'function' || !isTauriApp()) return;
    const now = Date.now();
    const queue = getFavorites().filter(item => now - (item.checkedAt || 0) >= FAVORITE_CHECK_INTERVAL_MS);
    if (!queue.length) return;

    favoritesState.checking = true;
    renderFavoritesPage();
    const worker = async () => {
        while (queue.length) {
            const item = queue.shift();
            try {
                const video = await fetchVodDetail(item.id, item.sourceCode);
                recordFavoriteCheck(item.sourceCode, item.id, preferredEpisodeCount(parsePlayLines(video)), video.vod_remarks || '');
            } catch (e) {
                recordFavoriteCheck(item.sourceCode, item.id, null);
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(FAVORITE_CHECK_CONCURRENCY, queue.length) }, worker));
    favoritesState.checking = false;
    renderFavoritesPage();
}

function sortedFavorites() {
    return getFavorites().sort((a, b) =>
        (b.hasUpdate ? 1 : 0) - (a.hasUpdate ? 1 : 0) || (b.addedAt || 0) - (a.addedAt || 0));
}

function favoriteCardHtml(item) {
    const badge = item.episodeCount > 1 ? `更新至第${item.episodeCount}集` : (item.remarks || '');
    const subtitle = [item.sourceName, item.year].filter(Boolean).join(' · ');
    return `<button type="button" class="poster-card favorite-card" data-fav-source="${escapeHtml(item.sourceCode)}" data-fav-id="${escapeHtml(item.id)}" title="${escapeHtml(item.title)}">
        <div class="poster-thumb">
            ${posterImgHtml(item.cover || '', item.title)}
            ${item.hasUpdate ? '<span class="favorite-update">有更新</span>' : ''}
            ${badge ? `<span class="poster-badge">${escapeHtml(badge)}</span>` : ''}
            <span class="favorite-remove" data-fav-remove role="button" aria-label="取消收藏">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </span>
        </div>
        <div class="poster-title">${escapeHtml(item.title)}</div>
        ${subtitle ? `<div class="poster-sub">${escapeHtml(subtitle)}</div>` : ''}
    </button>`;
}

function updateFavoritesTabDot(list = getFavorites()) {
    document.querySelector('#mineTabs .tab-dot')?.classList.toggle('hidden', !list.some(item => item.hasUpdate));
}

function isFavoritesTabActive() {
    const container = document.getElementById('favoritesList');
    return !!container && !container.classList.contains('hidden');
}

function renderFavoritesPage() {
    const container = document.getElementById('favoritesList');
    if (!container) return;
    const list = sortedFavorites();
    updateFavoritesTabDot(list);
    if (!list.length) favoritesState.managing = false;

    const manageBtn = document.getElementById('favoritesManageBtn');
    if (manageBtn) {
        manageBtn.classList.toggle('hidden', !list.length || !isFavoritesTabActive());
        manageBtn.textContent = favoritesState.managing ? '完成' : '管理';
    }

    if (!list.length) {
        container.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>
            <p>还没有收藏</p>
            <span>在详情里点「收藏」，追的剧有新集时会在这里提示</span>
        </div>`;
        return;
    }
    container.innerHTML = `${favoritesState.checking ? '<p class="favorites-status">正在检查更新…</p>' : ''}
        <div class="poster-grid${favoritesState.managing ? ' managing' : ''}">${list.map(favoriteCardHtml).join('')}</div>`;
}

function showMineTab(tab) {
    const fav = tab === 'fav';
    document.querySelectorAll('#mineTabs [data-mine-tab]').forEach(btn => {
        const active = btn.dataset.mineTab === tab;
        btn.classList.toggle('active', active);
        btn.setAttribute('aria-selected', String(active));
    });
    document.getElementById('historyList')?.classList.toggle('hidden', fav);
    document.getElementById('favoritesList')?.classList.toggle('hidden', !fav);
    document.getElementById('historyClearBtn')?.classList.toggle('hidden', fav);
    if (fav) {
        renderFavoritesPage();
        checkFavoriteUpdates();
    } else {
        favoritesState.managing = false;
        document.getElementById('favoritesManageBtn')?.classList.add('hidden');
        renderHistoryPage();
    }
}

function setupFavoritesPage() {
    const container = document.getElementById('favoritesList');
    if (!container) return;

    document.getElementById('mineTabs')?.addEventListener('click', (e) => {
        const tab = e.target.closest('[data-mine-tab]');
        if (tab) replaceHash(tab.dataset.mineTab === 'fav' ? '#history/fav' : '#history');
    });

    document.getElementById('favoritesManageBtn')?.addEventListener('click', () => {
        favoritesState.managing = !favoritesState.managing;
        renderFavoritesPage();
    });

    container.addEventListener('click', (e) => {
        const card = e.target.closest('[data-fav-id]');
        if (!card) return;
        const { favSource, favId } = card.dataset;
        if (e.target.closest('[data-fav-remove]')) {
            removeFavorite(favSource, favId);
            renderFavoritesPage();
            showToast('已取消收藏', 'success');
            return;
        }
        if (favoritesState.managing) return;
        const item = findFavorite(getFavorites(), favSource, favId);
        if (item) showDetails(item.id, item.title, item.sourceCode);
    });

    updateFavoritesTabDot();
}

document.addEventListener('DOMContentLoaded', setupFavoritesPage);
