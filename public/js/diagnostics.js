// 设置页「诊断信息」：把车机/浏览器上报问题需要的环境数据集中显示，支持一键复制
// 车机上装不了调试工具，用户只能靠这段文本反馈问题

function diagnosticsSafe(fn, fallback = '—') {
    try {
        const value = fn();
        return value === undefined || value === null || value === '' ? fallback : String(value);
    } catch (e) {
        return fallback;
    }
}

function diagnosticsCssVar(name) {
    return diagnosticsSafe(() => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), '');
}

// 播放页和设置页是两次页面加载，播放现场的缓冲/码率数据由 player_buffer.js 写进 localStorage
const DIAGNOSTICS_PLAYER_STATS_KEY = 'playerStats';

function readPlayerStats() {
    try {
        const stats = JSON.parse(localStorage.getItem(DIAGNOSTICS_PLAYER_STATS_KEY) || 'null');
        return stats && typeof stats === 'object' ? stats : null;
    } catch (e) {
        return null;
    }
}

// 播放列表里的广告标记统计，由 player_artplayer_handler.js 的 filterAdsFromM3U8 写入。
// 各采集站的标记不统一，这份数据用来判断该按哪种规则去广告。
const DIAGNOSTICS_MARKER_STATS_KEY = 'playlistMarkerStats';

function readMarkerStats() {
    try {
        const stats = JSON.parse(localStorage.getItem(DIAGNOSTICS_MARKER_STATS_KEY) || 'null');
        return stats && typeof stats === 'object' ? stats : null;
    } catch (e) {
        return null;
    }
}

function playlistMarkerRows(stats) {
    if (!stats) return ['  还没有解析过播放列表'];
    const rows = [];
    const add = (label, value) => rows.push(`  ${label}：${value}`);
    add('分片数', `${stats.segments || 0} 个`);
    add('DISCONTINUITY', `${stats.discontinuity || 0} 个`);
    add('CUE-OUT / CUE-IN', `${stats.cueOut || 0} / ${stats.cueIn || 0}`);
    add('DATERANGE', `${stats.daterange || 0} 个`);
    add('SCTE35', `${stats.scte35 || 0} 个`);
    add('已剔除广告分片', stats.aborted
        ? '标记覆盖范围过大，已放弃过滤（怀疑标记位置不对）'
        : `${stats.removed || 0} 个`);
    add('解析时间', formatClockTime(stats.at));
    return rows;
}

function formatBitrateKbps(bits) {
    const value = Number(bits) || 0;
    if (!value) return '未知';
    return `${Math.round(value / 1000)} kbps`;
}

function formatClockTime(ts) {
    if (!ts) return '未知';
    return new Date(ts).toLocaleString('zh-CN', { hour12: false });
}

function playerStatsRows(stats) {
    if (!stats) return ['播放统计：本机还没有播放记录'];
    const rows = [];
    const add = (label, value) => rows.push(`  ${label}：${value}`);
    add('片名', stats.title || '未知');
    add('集数', stats.episodeCount > 1 ? `第 ${stats.episodeIndex + 1} 集 / 共 ${stats.episodeCount} 集` : '单集');
    add('播放进度', `${stats.position || 0}s / ${stats.duration || 0}s`);
    add('播放引擎', stats.engine || '未知');
    add('前向缓冲', `${stats.bufferedAhead || 0}s`);
    add('码率档位', stats.levels > 1
        // hls.js 自动模式下 currentLevel 恒为 -1，直接显示 -1 会让人以为是错误
        ? `当前 ${stats.level >= 0 ? stats.level : '自动'}，封顶 ${stats.autoLevelCapping >= 0 ? stats.autoLevelCapping : '无'}，共 ${stats.levels} 档`
        : `共 ${stats.levels || 1} 档`);
    add('当前码率', formatBitrateKbps(stats.currentBitrate));
    add('带宽估计', formatBitrateKbps(stats.bandwidthEstimate));
    add('近 1 分钟卡顿', `${stats.stalls || 0} 次，自动降档 ${stats.downgrades || 0} 次，自动换源 ${stats.switches || 0} 次`);
    if (stats.video) {
        const v = stats.video;
        // 解码成功时 videoWidth/Height 一定非 0；为 0 说明视频轨没解出来（有声音没画面）
        const size = v.width && v.height ? `${v.width}×${v.height}` : `未解码（${v.width}×${v.height}）`;
        const extra = [];
        if (typeof v.readyState === 'number') extra.push(`readyState ${v.readyState}`);
        if (v.errorCode) extra.push(`错误码 ${v.errorCode}`);
        add('画面', `${size}${extra.length ? `，${extra.join('，')}` : ''}`);
        add('视频元素', `${v.boxWidth}×${v.boxHeight}`);
    }
    if (stats.playerBox) {
        const b = stats.playerBox;
        add('播放器容器', `${b.width}×${b.height}${b.scrollTop ? `，左栏已滚动 ${b.scrollTop}px` : ''}`);
    }
    const worst = stats.worst;
    if (worst && (worst.minAhead >= 0 || worst.peakStalls)) {
        // 只报「几次卡顿」看不出规律，最低点和最密集的一分钟才能定位到具体位置
        if (worst.minAhead >= 0) {
            add('缓冲最低点', `${worst.minAhead}s（${worst.minAheadPosition}s 处，${formatClockTime(worst.minAheadAt)}）`);
        }
        if (worst.peakStalls) {
            add('卡顿最密集', `一分钟内 ${worst.peakStalls} 次（${worst.peakStallsPosition}s 处，${formatClockTime(worst.peakStallsAt)}）`);
        }
    }
    if (stats.config) {
        const c = stats.config;
        add('缓冲参数', `maxBufferLength ${c.maxBufferLength}，maxMaxBufferLength ${c.maxMaxBufferLength}，maxBufferHole ${c.maxBufferHole}，maxBufferSize ${Math.round((c.maxBufferSize || 0) / 1000000)}MB`);
        add('ABR 参数', `capLevelToPlayerSize ${c.capLevelToPlayerSize ? '开' : '关'}，abrBandWidthUpFactor ${c.abrBandWidthUpFactor}`);
    }
    add('统计时间', formatClockTime(stats.at));
    return rows;
}

function formatMegabytes(bytes) {
    const value = Number(bytes) || 0;
    if (!value) return '0 MB';
    return `${(value / 1000000).toFixed(1)} MB`;
}

// 分片缓存统计来自 IndexedDB，只能异步读；没有缓存模块时返回空数组，不影响其余诊断项
async function segmentCacheRows() {
    if (typeof segmentCacheSummary !== 'function') return [];
    const summary = await segmentCacheSummary();
    if (!summary) return [];
    const rows = ['【分片缓存】'];
    const add = (label, value) => rows.push(`  ${label}：${value}`);
    if (!summary.supported) {
        rows.push('  当前环境不支持 IndexedDB，分片缓存不可用');
        return rows;
    }
    add('状态', summary.enabled ? '已开启' : '已关闭');
    add('已缓存', `${summary.entries} 个分片，${formatMegabytes(summary.bytes)} / 上限 ${formatMegabytes(summary.limitBytes)}`);
    add('本次命中', `${summary.hits} 次，读 ${formatMegabytes(summary.bytesRead)}；未命中 ${summary.misses} 次`);
    add('本次写入', formatMegabytes(summary.bytesWritten));
    return rows;
}

// 下载模块只在播放页加载，设置页里没有，所以先判类型
async function downloadRows() {
    if (typeof downloadSummary !== 'function') return [];
    const summary = await downloadSummary();
    if (!summary) return [];
    const rows = ['【离线下载】'];
    const add = (label, value) => rows.push(`  ${label}：${value}`);
    if (!summary.supported) {
        rows.push('  当前环境不支持 IndexedDB，离线下载不可用');
        return rows;
    }
    add('已完成', `${summary.count} 集，${formatMegabytes(summary.bytes)} / 上限 ${formatMegabytes(summary.limit)}`);
    add('进行中', `${summary.active} 集，排队 ${summary.queued} 集`);
    const unfinished = (summary.rows || []).filter(record => record.status !== 'done');
    if (unfinished.length) {
        add('未完成', unfinished.map(record => `${record.label || record.index}（${record.done || 0}/${record.total || 0}）`).join('，'));
    }
    return rows;
}

// 设置页「存储」卡片。分片缓存和离线下载是两套独立的 IndexedDB，
// 「清除本地数据」会把它们连同配置一起清掉，所以这里单独给两个清理入口。
function formatStorageSize(bytes) {
    const value = Number(bytes) || 0;
    if (value <= 0) return '0 MB';
    if (value < 1000 * 1000) return `${Math.max(1, Math.round(value / 1000))} KB`;
    if (value < 1000 * 1000 * 1000) return `${(value / 1000 / 1000).toFixed(1)} MB`;
    return `${(value / 1000 / 1000 / 1000).toFixed(2)} GB`;
}

function storageRowHtml(label, value, hint, options) {
    const opts = options || {};
    // 可点击的行用 role=button，不再套一层 button（行里有三段文字，套了会破坏布局）
    const attrs = opts.goto
        ? ` role="button" tabindex="0" class="storage-row storage-row-link" data-storage-goto="${escapeHtml(opts.goto)}"`
        : ' class="storage-row"';
    return `<div${attrs}>
        <span class="storage-label">${escapeHtml(label)}</span>
        <span class="storage-value">${escapeHtml(value)}</span>
        ${hint ? `<span class="storage-hint">${escapeHtml(hint)}</span>` : ''}
    </div>`;
}

// 存储卡片和诊断面板共用的刷新入口，清完东西两边都要重新读一遍
function refreshStorageViews() {
    if (typeof renderStorageCard === 'function') {
        return Promise.resolve(renderStorageCard()).then(() => {
            if (typeof refreshDiagnostics === 'function') refreshDiagnostics();
        }).catch(() => {});
    }
    if (typeof refreshDiagnostics === 'function') refreshDiagnostics();
    return Promise.resolve();
}

// 下载内容存在 IndexedDB 里，不是磁盘文件，所以「打开下载目录」只能跳到下载列表
function gotoDownloadsPage() {
    window.location.hash = '#history/dl';
}


async function renderStorageCard() {
    const container = document.getElementById('storageRows');
    if (!container) return;
    const rows = [];

    if (typeof segmentCacheSummary === 'function') {
        const cache = await Promise.resolve().then(() => segmentCacheSummary()).catch(() => null);
        if (cache) {
            if (!cache.supported) rows.push(storageRowHtml('分片缓存', '不可用', '当前环境不支持 IndexedDB'));
            else if (!cache.enabled) rows.push(storageRowHtml('分片缓存', '已关闭', '在「功能开关」里打开后才会写入'));
            else rows.push(storageRowHtml('分片缓存', formatStorageSize(cache.bytes), `${cache.entries} 个分片 / 上限 ${formatStorageSize(cache.limitBytes)}`));
        }
    }

    if (typeof downloadSummary === 'function') {
        const summary = await Promise.resolve().then(() => downloadSummary()).catch(() => null);
        if (summary) {
            if (!summary.supported) {
                rows.push(storageRowHtml('离线下载', '不可用', '当前环境不支持 IndexedDB'));
            } else {
                const extra = summary.active || summary.queued
                    ? `，进行中 ${summary.active} 集，排队 ${summary.queued} 集`
                    : '';
                rows.push(storageRowHtml('离线下载', formatStorageSize(summary.bytes), `${summary.count} 集 / 上限 ${formatStorageSize(summary.limit)}${extra} · 点这里打开下载列表`, { goto: 'downloads' }));
            }
        }
    }

    if (navigator.storage && typeof navigator.storage.estimate === 'function') {
        const quota = await navigator.storage.estimate().catch(() => null);
        if (quota && quota.quota) {
            const free = Math.max(0, quota.quota - (quota.usage || 0));
            rows.push(storageRowHtml('剩余空间', formatStorageSize(free), `总配额 ${formatStorageSize(quota.quota)}`));
        }
    }

    container.innerHTML = rows.length ? rows.join('') : '<div class="storage-row"><span class="storage-label">暂时读不到存储占用</span></div>';
}

// 清空下载不可恢复，用确认弹窗。之前是「再点一次确认」的 toast，
// 车机上 toast 一闪就没，点空了会以为清成功了。
function clearSegmentCacheFromSettings() {
    if (typeof segmentCacheClear !== 'function') {
        showAlertDialog({ title: '清理失败', message: '分片缓存模块没加载，请刷新页面后再试。' });
        return Promise.resolve();
    }
    return Promise.resolve()
        .then(() => segmentCacheSummary())
        .then(summary => {
            if (summary && summary.supported && summary.enabled && !summary.entries) {
                return showAlertDialog({ title: '没有可清理的内容', message: '当前没有缓存的分片，不用清理。' });
            }
            const beforeBytes = summary && summary.bytes ? summary.bytes : 0;
            return showConfirmDialog({
                title: '清理分片缓存',
                message: '会删掉已经缓存的全部片段，下次播放要重新下载。离线下载的内容不受影响。',
                confirmText: '清理'
            }).then(ok => {
                if (!ok) return undefined;
                return withButtonBusy('clearSegmentCacheBtn', () => segmentCacheClear()
                    // segmentCacheClear 失败时返回 false，以前调用方不看返回值，删不掉也报「已清理」
                    .then(done => (done ? verifySegmentCacheCleared(beforeBytes) : false))
                    .then(cleared => {
                        if (!cleared) {
                            showAlertDialog({
                                title: '没清理成功',
                                message: '缓存还是原来的大小。可能有别的页面正占着这份缓存，关掉其它页面后刷新本页再试一次。'
                            });
                            return refreshStorageViews();
                        }
                        showToast('分片缓存已清理', 'success');
                        return refreshStorageViews();
                    }))
                    .catch(() => showAlertDialog({ title: '清理失败', message: '清理过程中出错了，刷新本页后再试一次。' }));
            });
        })
        .catch(() => undefined);
}

// 清完再读一遍，确认真的少了。之前只信 segmentCacheClear 的返回值，
// 用户看到的现象是「提示清掉了但大小没变」，所以这里以实际读到的数字为准
function verifySegmentCacheCleared(beforeBytes) {
    if (!beforeBytes) return Promise.resolve(true);
    return Promise.resolve()
        .then(() => segmentCacheSummary())
        .then(after => (after && Number(after.bytes) < beforeBytes ? true : false))
        .catch(() => false);
}

function verifyDownloadsCleared(beforeCount) {
    if (!beforeCount) return Promise.resolve(true);
    return Promise.resolve()
        .then(() => downloadSummary())
        .then(after => (after && !after.count && !after.active && !after.queued ? true : false))
        .catch(() => false);
}

function clearDownloadsFromSettings() {
    if (typeof downloadClear !== 'function') {
        showAlertDialog({ title: '清空失败', message: '下载模块没加载，请刷新页面后再试。' });
        return Promise.resolve();
    }
    return Promise.resolve()
        .then(() => downloadSummary())
        .then(summary => {
            if (summary && summary.supported && !summary.count && !summary.active && !summary.queued) {
                return showAlertDialog({ title: '没有可清空的内容', message: '当前没有离线下载，不用清空。' });
            }
            const beforeCount = summary && summary.count ? summary.count : 0;
            return showConfirmDialog({
                title: '清空离线下载',
                message: '会删掉全部已下载和正在下载的集数，重新看要重新下。这个操作不可恢复。',
                confirmText: '清空'
            }).then(ok => {
                if (!ok) return undefined;
                return withButtonBusy('clearDownloadsBtn', () => downloadClear()
                    .then(done => (done === false ? false : verifyDownloadsCleared(beforeCount)))
                    .then(cleared => {
                        if (!cleared) {
                            showAlertDialog({
                                title: '没清空成功',
                                message: '下载记录还在。请刷新本页后再试一次。'
                            });
                            return refreshStorageViews();
                        }
                        showToast('离线下载已清空', 'success');
                        return refreshStorageViews();
                    }))
                    .catch(() => showAlertDialog({ title: '清空失败', message: '清空过程中出错了，刷新本页后再试一次。' }));
            });
        })
        .catch(() => undefined);
}

async function collectDiagnostics() {
    const vv = window.visualViewport;
    const rows = [];
    const add = (label, value) => rows.push(`${label}：${value}`);

    let version = '网页版';
    if (typeof isTauriApp === 'function' && isTauriApp()) {
        version = await diagnosticsSafeAsync(() => tauriInvoke('plugin:app|version'), '未知');
    }
    add('应用版本', version);
    add('运行环境', typeof isTauriApp === 'function' && isTauriApp() ? 'Tauri 客户端' : '浏览器');
    add('系统', diagnosticsSafe(() => navigator.userAgent));
    add('平台', diagnosticsSafe(() => navigator.platform));
    add('屏幕', `${diagnosticsSafe(() => screen.width)}×${diagnosticsSafe(() => screen.height)}，像素比 ${diagnosticsSafe(() => window.devicePixelRatio)}`);
    add('窗口', `${diagnosticsSafe(() => window.innerWidth)}×${diagnosticsSafe(() => window.innerHeight)}`);
    add('文档区', `${diagnosticsSafe(() => document.documentElement.clientWidth)}×${diagnosticsSafe(() => document.documentElement.clientHeight)}`);
    add('可视区', vv
        ? `${Math.round(vv.width)}×${Math.round(vv.height)}，顶部偏移 ${Math.round(vv.offsetTop || 0)}，缩放 ${diagnosticsSafe(() => vv.scale)}`
        : '不支持 visualViewport');
    add('安全区', `上 ${diagnosticsCssVar('--safe-top') || '0px'}，下 ${diagnosticsCssVar('--safe-bottom') || '0px'}`);
    add('方向', diagnosticsSafe(() => (window.matchMedia('(orientation: landscape)').matches ? '横屏' : '竖屏')));
    add('页面滚动锁', document.body.style.overflow === 'hidden' ? '已锁定' : '正常');
    add('采集时间', new Date().toLocaleString('zh-CN', { hour12: false }));
    // 缓冲相关的现场数据放在最后，方便复制后直接看
    rows.push('');
    rows.push('【上次播放】');
    rows.push(...playerStatsRows(readPlayerStats()));
    rows.push('');
    rows.push('【播放列表】');
    rows.push(...playlistMarkerRows(readMarkerStats()));
    const cacheRows = await segmentCacheRows();
    if (cacheRows.length) {
        rows.push('');
        rows.push(...cacheRows);
    }
    const downloads = await downloadRows();
    if (downloads.length) {
        rows.push('');
        rows.push(...downloads);
    }
    return rows.join('\n');
}

function diagnosticsSafeAsync(fn, fallback) {
    return Promise.resolve()
        .then(fn)
        .then(value => (value === undefined || value === null || value === '' ? fallback : String(value)))
        .catch(() => fallback);
}

async function refreshDiagnostics() {
    const output = document.getElementById('diagnosticsOutput');
    if (!output) return;
    try {
        output.textContent = await collectDiagnostics();
    } catch (e) {
        output.textContent = `采集失败：${e && e.message ? e.message : e}`;
    }
}

// 老 WebView 不一定有 navigator.clipboard，退回 textarea + execCommand
function copyDiagnostics() {
    const output = document.getElementById('diagnosticsOutput');
    const text = output ? output.textContent : '';
    if (!text) {
        showToast('没有可复制的内容', 'error');
        return;
    }
    const fallbackCopy = () => {
        try {
            const area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', '');
            area.style.position = 'fixed';
            area.style.top = '-1000px';
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand('copy');
            document.body.removeChild(area);
            showToast(ok ? '诊断信息已复制' : '复制失败，请长按选中文本', ok ? 'success' : 'error');
        } catch (e) {
            showToast('复制失败，请长按选中文本', 'error');
        }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => showToast('诊断信息已复制', 'success'), fallbackCopy);
    } else {
        fallbackCopy();
    }
}

function setupDiagnostics() {
    const copyBtn = document.getElementById('diagnosticsCopyBtn');
    const refreshBtn = document.getElementById('diagnosticsRefreshBtn');
    if (copyBtn) copyBtn.addEventListener('click', () => withButtonBusy(copyBtn, copyDiagnostics));
    if (refreshBtn) {
        refreshBtn.addEventListener('click', () => withButtonBusy(refreshBtn, () => {
            if (typeof renderStorageCard === 'function') return Promise.resolve(renderStorageCard()).then(refreshDiagnostics);
            refreshDiagnostics();
            return undefined;
        }));
    }

    // 存储卡片里「离线下载」那行可点，直接跳到下载列表
    const storageRows = document.getElementById('storageRows');
    if (storageRows) {
        storageRows.addEventListener('click', e => {
            const row = e.target.closest('[data-storage-goto]');
            if (row) gotoDownloadsPage();
        });
        storageRows.addEventListener('keydown', e => {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            const row = e.target.closest('[data-storage-goto]');
            if (!row) return;
            e.preventDefault();
            gotoDownloadsPage();
        });
    }

    const page = document.getElementById('page-settings');
    const visible = () => !!page && !page.classList.contains('hidden');

    const refreshAll = () => {
        refreshDiagnostics();
        renderStorageCard();
    };

    // 设置页由 app_shell 统一切换 hidden，用 MutationObserver 盯住它，比监听 hashchange 稳：
    // 从搜索页进设置走的是 location.replace，不一定触发 hashchange
    if (page && typeof MutationObserver === 'function') {
        new MutationObserver(() => { if (visible()) refreshAll(); })
            .observe(page, { attributes: true, attributeFilter: ['class'] });
    }

    // 旋转、键盘弹出会改变可见区，设置页开着时跟着刷新，避免显示过期数据
    const refreshIfVisible = () => { if (visible()) refreshAll(); };
    window.addEventListener('resize', refreshIfVisible);
    window.addEventListener('orientationchange', refreshIfVisible);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', refreshIfVisible);
    refreshIfVisible();
}

document.addEventListener('DOMContentLoaded', setupDiagnostics);
