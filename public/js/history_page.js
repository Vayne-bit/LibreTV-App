// 观看历史页：按今天 / 昨天 / 更早分组

function historyDayGroup(timestamp) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const today = startOfToday.getTime();
    if (timestamp >= today) return '今天';
    if (timestamp >= today - 86400000) return '昨天';
    return '更早';
}

function historyCardHtml(item, index) {
    const total = Array.isArray(item.episodes) ? item.episodes.length : 0;
    const episodeIndex = item.episodeIndex || 0;
    const names = Array.isArray(item.episodeNames) ? item.episodeNames : [];
    const episodeLabel = total > 1 ? `看到 ${names[episodeIndex] || `第${episodeIndex + 1}集`}` : '';
    const hasProgress = item.playbackPosition > 10 && item.duration > 0;
    const percent = hasProgress ? Math.min(100, Math.round((item.playbackPosition / item.duration) * 100)) : 0;
    const progressText = hasProgress
        ? (percent >= 95 ? '已看完' : `${formatPlaybackTime(item.playbackPosition)} / ${formatPlaybackTime(item.duration)}`)
        : '';
    const line = [episodeLabel, progressText].filter(Boolean).join(' · ') || '未开始播放';

    return `<button type="button" class="history-card" data-history-index="${index}">
        <div class="history-cover">
            ${posterImgHtml(item.cover || '', item.title)}
            ${hasProgress ? `<div class="history-bar"><i style="width:${percent}%"></i></div>` : ''}
        </div>
        <div class="history-body">
            <div class="history-name">${escapeHtml(item.title)}</div>
            <div class="history-line">${escapeHtml(line)}</div>
            <div class="history-line faint">${escapeHtml([item.sourceName, formatTimestamp(item.timestamp)].filter(Boolean).join(' · '))}</div>
        </div>
        <span class="history-delete icon-btn" data-history-delete="${index}" role="button" aria-label="删除记录">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </span>
    </button>`;
}

function renderHistoryPage() {
    const container = document.getElementById('historyList');
    if (!container) return;
    const history = getViewingHistory();
    if (history.length === 0) {
        container.innerHTML = `<div class="empty-state">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 3"/></svg>
            <p>还没有观看记录</p>
            <span>看过的视频会出现在这里，方便继续观看</span>
        </div>`;
        return;
    }

    const groups = [];
    history.forEach((item, index) => {
        const name = historyDayGroup(item.timestamp || 0);
        let group = groups.find(g => g.name === name);
        if (!group) { group = { name, cards: [] }; groups.push(group); }
        group.cards.push(historyCardHtml(item, index));
    });
    container.innerHTML = groups.map(g =>
        `<div class="history-group-title">${g.name}</div><div class="history-grid">${g.cards.join('')}</div>`
    ).join('');
}

function setupHistoryPage() {
    const container = document.getElementById('historyList');
    if (!container) return;
    container.addEventListener('click', (e) => {
        const history = getViewingHistory();
        const del = e.target.closest('[data-history-delete]');
        if (del) {
            e.stopPropagation();
            const item = history[parseInt(del.dataset.historyDelete, 10)];
            if (item) {
                localStorage.setItem('viewingHistory', JSON.stringify(history.filter(h => h !== item)));
                renderHistoryPage();
                showToast('已删除该记录', 'success');
            }
            return;
        }
        const card = e.target.closest('[data-history-index]');
        if (!card) return;
        const item = history[parseInt(card.dataset.historyIndex, 10)];
        if (item) playFromHistory(item.url || '', item.title, item.episodeIndex || 0, item.playbackPosition || 0);
    });
}

document.addEventListener('DOMContentLoaded', setupHistoryPage);
