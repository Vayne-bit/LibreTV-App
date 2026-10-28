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
    if (copyBtn) copyBtn.addEventListener('click', copyDiagnostics);
    if (refreshBtn) refreshBtn.addEventListener('click', refreshDiagnostics);

    const page = document.getElementById('page-settings');
    const visible = () => !!page && !page.classList.contains('hidden');

    // 设置页由 app_shell 统一切换 hidden，用 MutationObserver 盯住它，比监听 hashchange 稳：
    // 从搜索页进设置走的是 location.replace，不一定触发 hashchange
    if (page && typeof MutationObserver === 'function') {
        new MutationObserver(() => { if (visible()) refreshDiagnostics(); })
            .observe(page, { attributes: true, attributeFilter: ['class'] });
    }

    // 旋转、键盘弹出会改变可见区，设置页开着时跟着刷新，避免显示过期数据
    const refreshIfVisible = () => { if (visible()) refreshDiagnostics(); };
    window.addEventListener('resize', refreshIfVisible);
    window.addEventListener('orientationchange', refreshIfVisible);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', refreshIfVisible);
    refreshIfVisible();
}

document.addEventListener('DOMContentLoaded', setupDiagnostics);
