// 全局变量

// 顶层解析必须兜底：这里一旦抛异常，本文件后面所有全局变量都不会声明，
// initializeApp / setupEventListeners / initAppShell 全部跟着挂掉，
// 表现是整个 App 变砖（无导航、无响应，只能清站点数据救回来）。
// 存储损坏的来源之一是「导入配置」写过未校验的值（config_io.js 已加白名单兜底）。
function safeParseOrDefault(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed === null || parsed === undefined ? fallback : parsed;
    } catch (e) {
        console.warn(`[app_globals] localStorage[${key}] 内容损坏，已回退默认值:`, e && e.message);
        return fallback;
    }
}

function safeArrayOrDefault(key, fallback) {
    const parsed = safeParseOrDefault(key, fallback);
    return Array.isArray(parsed) ? parsed : fallback;
}

let selectedAPIs = safeArrayOrDefault('selectedAPIs', ["tyyszy", "xiaomaomi", "dyttzy", "bfzy", "ruyi"]); // 默认选中的资源站
let customAPIs = safeArrayOrDefault('customAPIs', []); // 存储自定义API列表
if (!Array.isArray(customAPIs)) customAPIs = [];
// 列表项必须是对象（导入坏数据可能是字符串/数字），保证后续 .name/.url 访问不炸
customAPIs = customAPIs.filter(item => item && typeof item === 'object');

// 添加当前播放的集数索引
let currentEpisodeIndex = 0;
// 添加当前视频的所有集数
let currentEpisodes = [];
// 添加当前视频的标题
let currentVideoTitle = '';
// 全局变量用于倒序状态
let episodesReversed = false;

// Note: window.currentDetailContext was removed as per previous comments in the original app.js
// If any other global variables are identified as needed during further refactoring, they can be added here.
