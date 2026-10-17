// 数据源健康度：后台探测各源可用性，结果缓存后用于设置页提示

const SOURCE_HEALTH_KEY = 'sourceHealth';
const SOURCE_HEALTH_TTL_MS = 6 * 60 * 60 * 1000;
const SOURCE_HEALTH_DELAY_MS = 3000;
const SOURCE_HEALTH_PROBE_TIMEOUT_SECS = 5;

function readSourceHealth() {
    try {
        const cached = JSON.parse(localStorage.getItem(SOURCE_HEALTH_KEY) || 'null');
        if (!cached || !cached.checkedAt || !cached.sources) return null;
        if (Date.now() - cached.checkedAt > SOURCE_HEALTH_TTL_MS) return null;
        return cached;
    } catch (e) {
        return null;
    }
}

function writeSourceHealth(sources) {
    try {
        localStorage.setItem(SOURCE_HEALTH_KEY, JSON.stringify({ checkedAt: Date.now(), sources }));
    } catch (e) { /* 存储失败不影响使用 */ }
}

// 用搜索接口探测：只要返回了 list 就算这个源活着
async function probeSourceHealth(sourceCode) {
    const started = Date.now();
    try {
        const response = await handleSingleSourceSearch('测试', sourceCode, null);
        const ok = !!response && Array.isArray(response.list);
        return { code: sourceCode, ok, ms: Date.now() - started };
    } catch (e) {
        return { code: sourceCode, ok: false, ms: 0 };
    }
}

async function runSourceHealthCheck(force = false) {
    const cached = !force && readSourceHealth();
    if (cached) {
        renderSourceHealth(cached.sources);
        return cached.sources;
    }
    if (typeof selectedAPIs === 'undefined' || !Array.isArray(selectedAPIs)) return [];
    const results = [];
    for (const code of selectedAPIs) {
        const result = await probeSourceHealth(code);
        results.push(result);
        renderSourceHealth(results);
    }
    writeSourceHealth(results);
    renderSourceHealth(results, true);
    return results;
}

function sourceHealthBadgeHtml(sourceCode) {
    const health = readSourceHealth();
    if (!health) return '';
    const record = health.sources.find(item => item.code === sourceCode);
    if (!record || record.ok) return '';
    return ' <em class="source-health-bad">失效</em>';
}

// 把失效源在设置页标灰，但不改变用户的选择
function renderSourceHealth(results, final) {
    const list = results || [];
    if (!list.length) return;
    list.forEach(record => {
        const input = document.querySelector(`input[data-api="${record.code}"]`);
        const row = input ? input.closest('.flex.items-center') : null;
        if (row) row.classList.toggle('source-unavailable', !record.ok);
    });
    const container = document.getElementById('apiSourceHealth');
    if (!container) return;
    const bad = list.filter(item => !item.ok);
    if (!final) {
        container.textContent = `正在检测数据源… ${list.length}/${selectedAPIs.length}`;
        container.classList.remove('hidden');
        return;
    }
    container.textContent = bad.length
        ? `${bad.length} 个数据源当前不可用（已标灰，仍可勾选）`
        : '所有数据源均可正常访问';
    container.classList.remove('hidden');
}

function scheduleSourceHealthCheck() {
    setTimeout(() => {
        runSourceHealthCheck().catch(() => { /* 探测失败静默 */ });
    }, SOURCE_HEALTH_DELAY_MS);
}
