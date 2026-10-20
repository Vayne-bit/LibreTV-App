// 跨设备同步：通过坚果云 WebDAV 存取进度文件
// 依赖 sync_core.js 提供的打包与合并能力
//
// 设计：一个同步组对应 WebDAV 上的一个 JSON 文件，
// 三台设备读写同一个文件，文件名即同步码。

const SYNC_WEBDAV_KEY = 'syncWebdav';
const SYNC_AUTO_INTERVAL_MS = 60000;
const SYNC_DAV_ROOT = 'https://dav.jianguoyun.com/dav';

const syncState = {
    busy: false,
    lastError: '',
    timer: null
};

// --- 凭证 ---

// 保存 { username, password, code }
function readSyncCredentials() {
    try {
        const cfg = JSON.parse(localStorage.getItem(SYNC_WEBDAV_KEY) || 'null');
        return cfg && cfg.username && cfg.password && cfg.code ? cfg : null;
    } catch (e) {
        return null;
    }
}

function writeSyncCredentials(creds) {
    if (!creds) {
        localStorage.removeItem(SYNC_WEBDAV_KEY);
        return;
    }
    localStorage.setItem(SYNC_WEBDAV_KEY, JSON.stringify(creds));
}

function syncConfigured() {
    return !!readSyncCredentials();
}

// 兼容旧接口：部分界面通过 readSyncConfig 取当前同步码
function readSyncConfig() {
    const creds = readSyncCredentials();
    return creds ? { code: creds.code } : null;
}

// 坚果云的 /dav/ 根目录不可写（PUT 返回 404，MKCOL 返回 409），
// 必须放在自带的「我的坚果云」目录下，这里用 URL 编码后的路径
const SYNC_ROOT_FOLDER = '%e6%88%91%e7%9a%84%e5%9d%9a%e6%9e%9c%e4%ba%91'; // 我的坚果云
function syncFilePath(code) {
    return `${SYNC_DAV_ROOT}/${SYNC_ROOT_FOLDER}/libretv-sync-${code}.json`;
}

function basicAuthHeader(username, password) {
    // 坚果云要求邮箱 + 应用密码，用 Basic 认证
    return `Basic ${btoa(`${username}:${password}`)}`;
}

async function davRequest(method, url, options) {
    const opts = options || {};
    const creds = readSyncCredentials();
    if (!creds) throw new Error('还没有配置坚果云账号');
    const headers = {
        'Authorization': basicAuthHeader(creds.username, creds.password)
    };
    if (opts.contentType) headers['Content-Type'] = opts.contentType;
    const response = await tauriInvoke('make_http_request', {
        options: {
            url,
            method,
            headers,
            body: opts.body,
            timeout_secs: opts.timeoutSecs || 20
        }
    });
    return response;
}

// 生成一个同步码，用随机 12 位十六进制，避免不同人撞名
function generateSyncCode() {
    const bytes = new Uint8Array(6);
    crypto.getRandomValues(bytes);
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// 同步文件直接放在 /dav/ 根目录，不需要建子目录
// 早期版本尝试 MKCOL 建 LibreTV 文件夹，坚果云返回 409，已去掉这一步

// --- 读写 ---

// 前置校验：访问「我的坚果云」目录，确认账号密码有效
// 目录是集合，GET 会返回 403/200，401 才是密码错误
// 这样能把「密码错」和「文件不存在」区分开
async function verifyCredentials() {
    const creds = readSyncCredentials();
    if (!creds) return { ok: false, reason: '未配置同步' };
    try {
        const response = await davRequest('GET', `${SYNC_DAV_ROOT}/${SYNC_ROOT_FOLDER}/`, { timeoutSecs: 15 });
        if (response.status === 401) return { ok: false, reason: '坚果云账号或应用密码不正确' };
        if (response.status === 403 || response.status === 200 || response.status === 301) {
            return { ok: true };
        }
        // 404 说明账号下找不到「我的坚果云」目录，通常仍是认证问题
        if (response.status === 404) {
            return { ok: false, reason: '坚果云账号或应用密码不正确' };
        }
        return { ok: false, reason: `认证检查失败（${response.status}）` };
    } catch (e) {
        return { ok: false, reason: e.message || '网络错误' };
    }
}

async function pullSync() {
    const creds = readSyncCredentials();
    if (!creds) return { ok: false, reason: '未配置同步' };
    try {
        const response = await davRequest('GET', syncFilePath(creds.code));
        if (response.status === 401) return { ok: false, reason: '坚果云账号或应用密码不正确' };
        if (response.status === 404) {
            // 文件还不存在，说明是第一次同步
            return { ok: true, applied: null, empty: true };
        }
        if (response.status !== 200) return { ok: false, reason: `读取失败（${response.status}）` };
        let payload;
        try {
            payload = JSON.parse(response.body);
        } catch (e) {
            return { ok: false, reason: '云端文件格式损坏' };
        }
        const applied = applySyncPayload(payload);
        return { ok: true, applied };
    } catch (e) {
        return { ok: false, reason: e.message || '网络错误' };
    }
}

async function pushSync() {
    const creds = readSyncCredentials();
    if (!creds) return { ok: false, reason: '未配置同步' };
    try {
        const payload = buildSyncPayload();
        const response = await davRequest('PUT', syncFilePath(creds.code), {
            contentType: 'application/json',
            body: JSON.stringify(payload),
            timeoutSecs: 30
        });
        if (response.status === 401) return { ok: false, reason: '坚果云账号或应用密码不正确' };
        if (response.status === 409) return { ok: false, reason: '坚果云拒绝写入，请检查账号是否有上传权限' };
        if (response.status !== 201 && response.status !== 204 && response.status !== 200) {
            return { ok: false, reason: `上传失败（${response.status}）` };
        }
        localStorage.setItem(SYNC_LAST_AT_KEY, String(Date.now()));
        return { ok: true };
    } catch (e) {
        return { ok: false, reason: e.message || '网络错误' };
    }
}

// --- 组合操作 ---

// 创建同步组：先验证账号，再生成一个码，把本地数据写上去
async function createSyncGroup(username, password) {
    const code = generateSyncCode();
    writeSyncCredentials({ username, password, code });
    const verified = await verifyCredentials();
    if (!verified.ok) {
        writeSyncCredentials(null);
        throw new Error(verified.reason || '账号验证失败');
    }
    const pushed = await pushSync();
    if (!pushed.ok) {
        writeSyncCredentials(null);
        throw new Error(pushed.reason || '创建失败');
    }
    return { code };
}

// 加入已有同步：填入同一份账号和码，拉取并合并
async function joinSyncGroup(username, password, code) {
    const normalized = String(code || '').trim().toUpperCase();
    if (!normalized) throw new Error('请填写同步码');
    writeSyncCredentials({ username, password, code: normalized });
    // 先确认账号密码有效，再判断同步码是否存在
    const verified = await verifyCredentials();
    if (!verified.ok) {
        writeSyncCredentials(null);
        throw new Error(verified.reason || '账号验证失败');
    }
    const pulled = await pullSync();
    if (!pulled.ok) {
        writeSyncCredentials(null);
        throw new Error(pulled.reason || '加入失败');
    }
    if (pulled.empty) {
        writeSyncCredentials(null);
        throw new Error('这个同步码下还没有数据，请检查是否抄写正确');
    }
    await pushSync();
    return pulled;
}

async function syncNow() {
    if (syncState.busy) return { ok: false, reason: '正在同步中' };
    if (!syncConfigured()) return { ok: false, reason: '未配置同步' };
    syncState.busy = true;
    syncState.lastError = '';
    try {
        const pulled = await pullSync();
        if (!pulled.ok) {
            syncState.lastError = pulled.reason;
            return pulled;
        }
        const pushed = await pushSync();
        if (!pushed.ok) syncState.lastError = pushed.reason;
        return pushed.ok ? { ok: true, applied: pulled.applied } : pushed;
    } finally {
        syncState.busy = false;
        renderSyncStatus();
    }
}

function startSyncTimer() {
    if (syncState.timer) clearInterval(syncState.timer);
    if (!syncConfigured()) return;
    syncState.timer = setInterval(() => {
        syncNow().catch(() => { /* 静默 */ });
    }, SYNC_AUTO_INTERVAL_MS);
}

function stopSyncTimer() {
    if (syncState.timer) clearInterval(syncState.timer);
    syncState.timer = null;
}

function formatSyncTime(ts) {
    if (!ts) return '尚未同步';
    const diff = Date.now() - ts;
    if (diff < 60000) return '刚刚同步';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前同步`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前同步`;
    return `${Math.floor(diff / 86400000)} 天前同步`;
}

function renderSyncStatus() {
    const el = document.getElementById('syncStatusText');
    if (!el) return;
    const creds = readSyncCredentials();
    if (!creds) {
        el.textContent = '未开启同步';
        return;
    }
    if (syncState.busy) {
        el.textContent = '同步中…';
        return;
    }
    if (syncState.lastError) {
        el.textContent = `同步失败：${syncState.lastError}`;
        return;
    }
    el.textContent = `同步码 ${creds.code} · ${formatSyncTime(lastSyncAt())}`;
}

// --- 设置页同步交互 ---

function readSyncForm() {
    const user = document.getElementById('syncUserInput');
    const pass = document.getElementById('syncPassInput');
    return {
        username: user ? user.value.trim() : '',
        password: pass ? pass.value.trim() : ''
    };
}

async function handleSyncCreate() {
    const form = readSyncForm();
    if (!form.username || !form.password) {
        showToast('请先填写坚果云账号和应用密码', 'error');
        return;
    }
    try {
        const group = await createSyncGroup(form.username, form.password);
        renderSyncStatus();
        startSyncTimer();
        showSyncCodeDialog(group.code, form.username);
    } catch (e) {
        showToast(e.message || '创建失败', 'error');
    }
}

function handleSyncJoin() {
    const form = readSyncForm();
    if (!form.username || !form.password) {
        showToast('请先填写坚果云账号和应用密码', 'error');
        return;
    }
    showSyncJoinDialog();
}

async function handleSyncNow() {
    if (!syncConfigured()) {
        showToast('请先创建或加入同步', 'error');
        return;
    }
    const result = await syncNow();
    if (!result.ok) {
        showToast(`同步失败：${result.reason || '未知错误'}`, 'error');
        return;
    }
    showToast('已同步', 'success');
    refreshAfterSync();
}

async function handleSyncDisconnect() {
    writeSyncCredentials(null);
    stopSyncTimer();
    renderSyncStatus();
    showToast('已断开同步', 'success');
}

function refreshAfterSync() {
    if (typeof renderHistoryPage === 'function') renderHistoryPage();
    if (typeof renderFavoritesPage === 'function') renderFavoritesPage();
    renderSyncStatus();
}

// 创建成功后展示同步码，其它设备要输入这个码加入
function showSyncCodeDialog(code, username) {
    const html = `
        <div class="sync-dialog">
            <p class="settings-hint">在其它设备上填同样的坚果云账号和应用密码，再加入这个同步码：</p>
            <div class="sync-code">${escapeHtml(code)}</div>
            <p class="settings-hint">同步码只是云端文件夹名，不需要保密，但三台设备必须完全一致。</p>
            <div class="settings-buttons">
                <button type="button" class="btn-primary" onclick="copySyncCode('${escapeHtml(code)}')">复制同步码</button>
                <button type="button" class="btn-secondary" onclick="closeSyncDialog()">知道了</button>
            </div>
        </div>`;
    openSyncDialog(html);
}

function showSyncJoinDialog() {
    const html = `
        <div class="sync-dialog">
            <p>输入另一台设备上显示的同步码</p>
            <input id="syncJoinCode" type="text" class="input" placeholder="12 位字母数字" maxlength="16">
            <p class="settings-hint">坚果云账号和应用密码已在上一页填好，这里只需要同步码。</p>
            <div class="settings-buttons">
                <button type="button" class="btn-primary" onclick="submitSyncJoin()">加入</button>
                <button type="button" class="btn-secondary" onclick="closeSyncDialog()">取消</button>
            </div>
        </div>`;
    openSyncDialog(html);
}

async function submitSyncJoin() {
    const codeEl = document.getElementById('syncJoinCode');
    const code = codeEl ? codeEl.value.trim() : '';
    if (!code) {
        showToast('请填写同步码', 'error');
        return;
    }
    const form = readSyncForm();
    if (!form.username || !form.password) {
        showToast('请先填写坚果云账号和应用密码', 'error');
        return;
    }
    try {
        await joinSyncGroup(form.username, form.password, code);
        closeSyncDialog();
        renderSyncStatus();
        startSyncTimer();
        refreshAfterSync();
        showToast('已加入同步', 'success');
    } catch (e) {
        showToast(e.message || '加入失败', 'error');
    }
}

function copySyncCode(code) {
    navigator.clipboard.writeText(code)
        .then(() => showToast('已复制同步码', 'success'))
        .catch(() => showToast('复制失败，请手动抄写', 'error'));
}

function openSyncDialog(html) {
    let overlay = document.getElementById('syncDialogOverlay');
    if (!overlay) {
        overlay = document.createElement('div');
        overlay.id = 'syncDialogOverlay';
        overlay.className = 'sync-overlay';
        document.body.appendChild(overlay);
    }
    overlay.innerHTML = `<div class="sync-dialog-box">${html}</div>`;
    overlay.classList.remove('hidden');
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeSyncDialog();
    });
}

function closeSyncDialog() {
    const overlay = document.getElementById('syncDialogOverlay');
    if (overlay) overlay.classList.add('hidden');
}

function setupSyncSettings() {
    const userInput = document.getElementById('syncUserInput');
    const passInput = document.getElementById('syncPassInput');
    const creds = readSyncCredentials();
    if (userInput) {
        userInput.value = creds ? creds.username : '';
        userInput.addEventListener('change', () => {
            const current = readSyncCredentials();
            if (!current) return;
            writeSyncCredentials({ ...current, username: userInput.value.trim() });
        });
    }
    if (passInput) {
        passInput.value = creds ? creds.password : '';
        passInput.addEventListener('change', () => {
            const current = readSyncCredentials();
            if (!current) return;
            writeSyncCredentials({ ...current, password: passInput.value.trim() });
        });
    }
    const bind = (id, handler) => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('click', handler);
    };
    bind('syncCreateBtn', handleSyncCreate);
    bind('syncJoinBtn', handleSyncJoin);
    bind('syncNowBtn', handleSyncNow);
    bind('syncDisconnectBtn', handleSyncDisconnect);
    renderSyncStatus();
}

// 启动时补全作品标识，并尝试同步一次
async function bootstrapSync() {
    backfillCanonicalIds();
    setupSyncSettings();
    if (!syncConfigured()) return;
    const result = await syncNow();
    if (result.ok) refreshAfterSync();
    startSyncTimer();
}
