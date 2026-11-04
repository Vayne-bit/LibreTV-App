// 配置文件导入功能
async function importConfig() {
    // showImportBox is assumed to be global or in ui.js
    if (typeof showImportBox !== 'function') {
        console.error("showImportBox function not found.");
        if (typeof showToast === 'function') showToast('导入功能不可用', 'error');
        return;
    }

    showImportBox(async (file) => {
        try {
            if (!(file.type === 'application/json' || file.name.endsWith('.json'))) throw '文件类型不正确';
            if(file.size > 1024 * 1024 * 10) throw new Error('文件大小超过 10MB'); // Corrected error throwing
            const content = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(reader.result);
                reader.onerror = () => reject('文件读取失败'); // Corrected error throwing
                reader.readAsText(file);
            });
            const config = JSON.parse(content);
            if (config.name !== 'LibreTV-Settings') throw '配置文件格式不正确'; // Corrected error throwing
            
            // sha256 is assumed to be global or in a utility file (e.g., sha256.js)
            if (typeof sha256 !== 'function') {
                console.error("sha256 function not found. Cannot verify config hash.");
                throw "无法验证配置文件哈希"; // Corrected error throwing
            }
            const dataHash = await sha256(JSON.stringify(config.data));
            if (dataHash !== config.hash) throw '配置文件哈希值不匹配'; // Corrected error throwing

            // 白名单 + 值校验：导入文件是任意外部输入，原样 setItem 等于把
            // passwordVerified / hasSeenDisclaimer 等认证状态也一起放进来，
            // 而且坏值（如 selectedAPIs 写成 "{"）会在下次启动时把整个 App 变砖。
            const importableKeys = new Set([
                'selectedAPIs',
                'customAPIs',
                'yellowFilterEnabled',
                'doubanEnabled',
                'doubanApiMode',
                'hasInitializedDefaults',
                PLAYER_CONFIG.adFilteringStorage,
                'viewingHistory',
                FAVORITES_KEY,
                SEARCH_HISTORY_KEY,
                'manualAdSegments',
                'introSkipMap',
                'learnedAdHosts',
                'sourceHealth',
            ]);
            const entries = Object.entries(config.data || {}).filter(([key]) =>
                importableKeys.has(key) || key.startsWith('videoProgress_'));
            const rejected = Object.keys(config.data || {}).length - entries.length;
            entries.forEach(([key, value]) => {
                // 只接受字符串值：localStorage 本来只存字符串，
                // 非字符串会被隐式 "[object Object]" 化成脏数据
                if (typeof value === 'string') localStorage.setItem(key, value);
            });
            if (rejected > 0 && typeof showToast === 'function') {
                showToast(`已跳过 ${rejected} 个不允许导入的配置项`, 'warning');
            }
            if (typeof showToast === 'function') showToast('配置文件导入成功，3 秒后自动刷新本页面。', 'success'); else console.log("Config imported successfully.");
            setTimeout(() => {
                window.location.reload();
            }, 3000);
        } catch (error) {
            const message = (typeof error === 'string' ? error : (error instanceof Error ? error.message : '配置文件格式错误'));
            if (typeof showToast === 'function') showToast(`配置文件读取出错 (${message})`, 'error'); else console.error(`Config import error: ${message}`);
        }
    });
}

// 配置文件导出功能
async function exportConfig() {
    const config = {};
    const items = {};
    const settingsToExport = [
        'selectedAPIs',
        'customAPIs',
        'yellowFilterEnabled',
        // 'adFilteringEnabled', // This key was in the original list but might be PLAYER_CONFIG.adFilteringStorage
        PLAYER_CONFIG.adFilteringStorage, // Using the constant from original app.js
        'doubanEnabled',
        'doubanApiMode', // Added from initializeApp defaults
        'hasInitializedDefaults'
    ];
    settingsToExport.forEach(key => {
        const value = localStorage.getItem(key);
        if (value !== null) {
            items[key] = value;
        }
    });
    const viewingHistory = localStorage.getItem('viewingHistory'); // Assuming 'viewingHistory' is the key
    if (viewingHistory) {
        items['viewingHistory'] = viewingHistory;
    }
    const favorites = localStorage.getItem(FAVORITES_KEY);
    if (favorites) {
        items[FAVORITES_KEY] = favorites;
    }
    // SEARCH_HISTORY_KEY is assumed to be global or defined elsewhere
    const searchHistory = localStorage.getItem(SEARCH_HISTORY_KEY); 
    if (searchHistory) {
        items[SEARCH_HISTORY_KEY] = searchHistory;
    }
    const times = Date.now().toString();
    config['name'] = 'LibreTV-Settings';
    config['time'] = times;
    config['cfgVer'] = '1.0.0';
    config['data'] = items;

    // sha256 is assumed to be global or in a utility file
    if (typeof sha256 !== 'function') {
        console.error("sha256 function not found. Cannot generate config hash for export.");
        if (typeof showToast === 'function') showToast('导出功能无法生成哈希。', 'error');
        return;
    }
    config['hash'] = await sha256(JSON.stringify(config['data']));
    saveStringAsFile(JSON.stringify(config), 'LibreTV-Settings_' + times + '.json');
}

// 将字符串保存为文件
function saveStringAsFile(content, fileName) {
    const blob = new Blob([content], { type: 'application/json;charset=utf-8' }); // Changed type to application/json
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    window.URL.revokeObjectURL(url);
}
