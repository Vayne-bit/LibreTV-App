// 下载管理页：挂在「我的」页的第三个 tab 上
// 已下载 / 未完成 两类，支持多选删除，点一下直接从离线文件播放

const DOWNLOAD_CHECK_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12.5l5.5 5.5L20 7"/></svg>';
const DOWNLOAD_EMPTY_ICON = '<svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M4 17.5v1.5a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-1.5"/></svg>';

const downloadPageState = {
    tab: 'done',
    managing: false,
    selected: new Set(),
    rows: [],
    live: []
};

function downloadSizeText(bytes) {
    const value = Number(bytes) || 0;
    if (value <= 0) return '0 MB';
    if (value < 1000 * 1000) return `${Math.max(1, Math.round(value / 1000))} KB`;
    if (value < 1000 * 1000 * 1000) return `${(value / 1000 / 1000).toFixed(1)} MB`;
    return `${(value / 1000 / 1000 / 1000).toFixed(2)} GB`;
}

function downloadTimeText(timestamp) {
    const value = Number(timestamp) || 0;
    if (!value) return '';
    const date = new Date(value);
    const pad = n => String(n).padStart(2, '0');
    return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function downloadEpisodeLabel(record) {
    const names = Array.isArray(record.episodeNames) ? record.episodeNames : [];
    const index = Number(record.index) || 0;
    return names[index] || record.label || `第${index + 1}集`;
}

function downloadStatusText(record) {
    const total = Number(record.total) || 0;
    const done = Number(record.done) || 0;
    if (record.status === 'queued') return '排队中';
    if (record.status === 'downloading') {
        const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
        return `下载中 ${percent}%`;
    }
    if (record.status === 'cancelled') return '已取消';
    return '已中断';
}

function downloadRowHtml(record) {
    const key = String(record.key || '');
    const selected = downloadPageState.selected.has(key);
    const done = record.status === 'done';
    const line = done
        ? [downloadEpisodeLabel(record), downloadSizeText(record.bytes)].filter(Boolean).join(' · ')
        : [downloadEpisodeLabel(record), downloadStatusText(record), downloadSizeText(record.bytes)].filter(Boolean).join(' · ');
    const sub = done
        ? [record.sourceName, downloadTimeText(record.updatedAt)].filter(Boolean).join(' · ')
        : (record.error || record.sourceName || '');
    const check = downloadPageState.managing
        ? `<span class="download-check${selected ? ' checked' : ''}" aria-hidden="true">${selected ? DOWNLOAD_CHECK_ICON : ''}</span>`
        : '';
    return `<button type="button" class="history-card download-row${selected ? ' selected' : ''}" data-download-key="${escapeHtml(key)}">
        <div class="history-cover">${posterImgHtml(record.cover || '', record.title || '')}</div>
        <div class="history-body">
            <div class="history-name">${escapeHtml(record.title || '未知视频')}</div>
            <div class="history-line">${escapeHtml(line)}</div>
            <div class="history-line faint">${escapeHtml(sub)}</div>
        </div>
        ${check}
    </button>`;
}

function downloadEmptyHtml(text, hint) {
    return `<div class="empty-state">${DOWNLOAD_EMPTY_ICON}<p>${escapeHtml(text)}</p><span>${escapeHtml(hint)}</span></div>`;
}

function downloadManageBarHtml(count) {
    if (!downloadPageState.managing) return '';
    return `<div class="download-manage-bar">
        <span>已选 ${count} 项</span>
        <button type="button" class="text-btn download-danger" data-download-delete${count ? '' : ' disabled'}>删除</button>
    </div>`;
}

function renderDownloadPage() {
    const container = document.getElementById('downloadsList');
    if (!container) return;

    const manageBtn = document.getElementById('downloadManageBtn');
    const visible = document.getElementById('downloadsList') && !document.getElementById('downloadsList').classList.contains('hidden');

    if (!isDownloadSupported()) {
        if (manageBtn) manageBtn.classList.add('hidden');
        container.innerHTML = downloadEmptyHtml('当前环境不支持离线下载', '需要浏览器支持 IndexedDB');
        return;
    }

    const done = downloadPageState.rows.filter(record => record.status === 'done');
    const unfinished = downloadPageState.rows.filter(record => record.status !== 'done');
    const liveKeys = new Set(downloadPageState.live.map(task => task.key));
    const activeRows = downloadPageState.live.slice()
        .concat(unfinished.filter(record => !liveKeys.has(record.key)));

    const count = downloadPageState.selected.size;
    const tabs = `<div class="chip-row download-tabs">
        <button type="button" class="chip${downloadPageState.tab === 'done' ? ' active' : ''}" data-download-tab="done">已下载 ${done.length}</button>
        <button type="button" class="chip${downloadPageState.tab === 'active' ? ' active' : ''}" data-download-tab="active">下载中 ${activeRows.length}</button>
    </div>`;

    const rows = downloadPageState.tab === 'done' ? done : activeRows;
    if (manageBtn) {
        const canManage = visible && downloadPageState.tab === 'done' && done.length > 0;
        manageBtn.classList.toggle('hidden', !canManage);
        manageBtn.textContent = downloadPageState.managing ? '完成' : '管理';
        if (!canManage && downloadPageState.managing) {
            downloadPageState.managing = false;
            downloadPageState.selected.clear();
        }
    }

    if (!rows.length) {
        const empty = downloadPageState.tab === 'done'
            ? downloadEmptyHtml('还没有下载任何集数', '在剧集列表里点每集右侧的下载图标，或播放器里的下载按钮')
            : downloadEmptyHtml('没有正在进行的下载', '下载会在你停留在播放页时进行，切走页面会中断');
        container.innerHTML = `${tabs}${downloadPageState.tab === 'done' ? downloadManageBarHtml(count) : ''}${empty}`;
        return;
    }

    container.innerHTML = `${tabs}${downloadPageState.tab === 'done' ? downloadManageBarHtml(count) : ''}
        <div class="history-grid">${rows.map(downloadRowHtml).join('')}</div>`;
}

function refreshDownloadPage() {
    const container = document.getElementById('downloadsList');
    if (!container) return Promise.resolve();
    if (!isDownloadSupported()) {
        renderDownloadPage();
        return Promise.resolve();
    }
    return markStaleDownloads()
        .then(() => listDownloadedEpisodes())
        .then(rows => {
            downloadPageState.rows = Array.isArray(rows) ? rows : [];
            downloadPageState.live = downloadSnapshot();
            const keys = new Set(downloadPageState.rows.map(record => record.key));
            downloadPageState.selected.forEach(key => {
                if (!keys.has(key)) downloadPageState.selected.delete(key);
            });
            renderDownloadPage();
        })
        .catch(() => renderDownloadPage());
}

function playDownloadedEpisode(key) {
    const record = downloadPageState.rows.find(row => row.key === key);
    if (!record) return;
    const episodes = Array.isArray(record.episodes) && record.episodes.length ? record.episodes.slice() : [record.url];
    const index = Math.max(0, Number(record.index) || 0);
    const url = record.url || episodes[index];
    if (!url) {
        showToast('这一集的地址丢了，请重新搜索', 'error');
        return;
    }
    // 和从历史记录继续观看走同一套参数，播放页才能还原剧集列表和集号
    localStorage.setItem('currentVideoTitle', record.title || '未知视频');
    localStorage.setItem('currentEpisodeIndex', String(index));
    localStorage.setItem('currentEpisodes', JSON.stringify(episodes));
    localStorage.setItem('currentEpisodeNames', JSON.stringify(Array.isArray(record.episodeNames) ? record.episodeNames : []));
    localStorage.setItem('currentVideoCover', record.cover || '');
    if (record.info) localStorage.setItem('currentVideoInfo', JSON.stringify(record.info));
    else localStorage.removeItem('currentVideoInfo');

    const params = new URLSearchParams({
        url,
        title: record.title || '',
        index: String(index),
        source: record.sourceName || '',
        source_code: record.sourceCode || ''
    });
    showVideoPlayer(`player.html?${params.toString()}`);
}

function deleteSelectedDownloads() {
    const keys = Array.from(downloadPageState.selected);
    if (!keys.length) return;
    deleteDownloadedEpisodes(keys).then(removed => {
        downloadPageState.selected.clear();
        showToast(removed ? `已删除 ${removed} 集` : '删除失败', removed ? 'success' : 'error');
        return refreshDownloadPage();
    });
}

function setupDownloadPage() {
    const container = document.getElementById('downloadsList');
    if (!container) return;

    document.getElementById('downloadManageBtn')?.addEventListener('click', () => {
        downloadPageState.managing = !downloadPageState.managing;
        if (!downloadPageState.managing) downloadPageState.selected.clear();
        renderDownloadPage();
    });

    container.addEventListener('click', e => {
        const tab = e.target.closest('[data-download-tab]');
        if (tab) {
            downloadPageState.tab = tab.dataset.downloadTab === 'active' ? 'active' : 'done';
            downloadPageState.selected.clear();
            downloadPageState.managing = false;
            renderDownloadPage();
            return;
        }
        if (e.target.closest('[data-download-delete]')) {
            deleteSelectedDownloads();
            return;
        }
        const row = e.target.closest('[data-download-key]');
        if (!row) return;
        const key = row.dataset.downloadKey;
        if (downloadPageState.managing) {
            if (downloadPageState.selected.has(key)) downloadPageState.selected.delete(key);
            else downloadPageState.selected.add(key);
            renderDownloadPage();
            return;
        }
        const record = downloadPageState.rows.find(item => item.key === key);
        if (record && record.status !== 'done') {
            showToast('这一集还没下完，可以删除后重新下载', 'error');
            return;
        }
        playDownloadedEpisode(key);
    });

    onDownloadChange(snapshot => {
        downloadPageState.live = Array.isArray(snapshot) ? snapshot : [];
        if (document.getElementById('downloadsList') && !document.getElementById('downloadsList').classList.contains('hidden')) {
            refreshDownloadPage();
        }
    });
}

document.addEventListener('DOMContentLoaded', setupDownloadPage);
