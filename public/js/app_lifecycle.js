window.addEventListener('pageshow', function(event) {
    const lastSearchQuery = sessionStorage.getItem('lastSearchQuery');
    const lastPageView = sessionStorage.getItem('lastPageView');

    console.log('[Pageshow] Event:', event.type, 'Persisted:', event.persisted, 'LastPageView:', lastPageView, 'Query:', lastSearchQuery);

    if (lastPageView === 'searchResults' && lastSearchQuery) {
        document.getElementById('searchInput').value = lastSearchQuery;
        if (event.persisted) {
            // Page restored from bfcache, search results should be in DOM.
            // Ensure correct UI visibility.
            console.log('[Pageshow-bfcache] Restoring search results view for query:', lastSearchQuery);
            document.getElementById('searchArea').classList.remove('flex-1');
            document.getElementById('searchArea').classList.add('mb-8');
            document.getElementById('resultsArea').classList.remove('hidden');
            const doubanArea = document.getElementById('doubanArea');
            if (doubanArea) doubanArea.classList.add('hidden');
        } else {
            // This is a full page load (not from bfcache).
            // initializeApp will handle re-running the search if necessary.
            console.log('[Pageshow-fullload] Search results were expected. initializeApp should handle re-search.');
        }
    } else {
        // Expected Douban home view or no specific state.
        if (event.persisted) {
             console.log('[Pageshow-bfcache] Restoring default/Douban view.');
            // Ensure default UI visibility if restored from bfcache
            document.getElementById('searchArea').classList.add('flex-1');
            document.getElementById('searchArea').classList.remove('mb-8');
            document.getElementById('resultsArea').classList.add('hidden');
            if (typeof updateDoubanVisibility === 'function') {
                updateDoubanVisibility();
            }
        } else {
            // Full load, initializeApp will set default Douban view.
            console.log('[Pageshow-fullload] Default/Douban view expected. initializeApp will handle.');
        }
    }
});

// Function to initialize the application after Tauri APIs are ready
function initializeApp() {
    console.log("[AppInit] Tauri API ready, initializing app.");
    // 初始化API复选框
    initAPICheckboxes();
    
    // 初始化自定义API列表
    renderCustomAPIsList();
    
    // 初始化显示选中的API数量
    updateSelectedApiCount();
    
    // 渲染搜索历史
    renderSearchHistory();
    
    // 设置默认API选择（如果是第一次加载）
    if (!localStorage.getItem('hasInitializedDefaults')) {
        // 仅选择天涯资源、暴风资源和如意资源
        selectedAPIs = ["tyyszy","xiaomaomi", "bfzy","dyttzy", "ruyi"];
        localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
        
        // 默认选中过滤开关
        localStorage.setItem('yellowFilterEnabled', 'true');
        localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, 'true');
        
        // 默认启用豆瓣功能
        localStorage.setItem('doubanEnabled', 'true');
        // 默认启用新旧豆瓣API模式
        localStorage.setItem('doubanApiMode', 'true');

        // 标记已初始化默认值
        localStorage.setItem('hasInitializedDefaults', 'true');
    }
    
    // 设置黄色内容过滤开关初始状态
    const yellowFilterToggle = document.getElementById('yellowFilterToggle');
    if (yellowFilterToggle) {
        yellowFilterToggle.checked = localStorage.getItem('yellowFilterEnabled') === 'true';
    }
    
    // 设置广告过滤开关初始状态
    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
        adFilterToggle.checked = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) !== 'false'; // 默认为true
    }

    // 设置豆瓣API模式开关初始状态
    const doubanApiModeToggle = document.getElementById('doubanApiModeToggle');
    if (doubanApiModeToggle) {
        const useNewAndOldApi = localStorage.getItem('doubanApiMode') !== 'false'; // Default true
        doubanApiModeToggle.checked = useNewAndOldApi;
        const toggleBg = doubanApiModeToggle.nextElementSibling;
        const toggleDot = toggleBg ? toggleBg.nextElementSibling : null;
        if (toggleBg && toggleDot) {
            if (useNewAndOldApi) {
                toggleBg.classList.add('bg-pink-600');
                toggleDot.classList.add('translate-x-6');
            } else {
                toggleBg.classList.remove('bg-pink-600');
                toggleDot.classList.remove('translate-x-6');
            }
        }
    }
    
    // 设置事件监听器
    setupEventListeners();
    
    // 初始检查成人API选中状态
    setTimeout(checkAdultAPIsSelected, 100);

    // Manually call initDouban from app.js after API is ready and other initializations
    if (typeof initDouban === 'function') {
        // Initialize a global flag for player return, if not already present
        if (typeof window.justReturnedFromPlayer === 'undefined') {
            window.justReturnedFromPlayer = false;
        }
        initDouban();
    } else {
        console.warn("[AppInit] initDouban function not found.");
    }

    const lastSearchQuery = sessionStorage.getItem('lastSearchQuery');
    const lastPageView = sessionStorage.getItem('lastPageView');

    // This check is primarily for full loads. Bfcache restores are handled by pageshow.
    if (lastPageView === 'searchResults' && lastSearchQuery) {
        console.log('[InitializeApp] Full load detected, and last view was search results. Re-searching for:', lastSearchQuery);
        document.getElementById('searchInput').value = lastSearchQuery;
        search(); // search() itself should set the UI correctly.
    } else {
        console.log('[InitializeApp] Full load, initializing default Douban view.');
        if (typeof initDouban === 'function') {
            initDouban(); // This should set the UI for Douban home.
        } else {
            console.warn("[AppInit] initDouban function not found.");
        }
        // Ensure UI state for Douban home, in case initDouban doesn't do it all.
        // Call resetSearchArea to set sessionStorage and UI for doubanHome if not already done by initDouban
        if (sessionStorage.getItem('lastPageView') !== 'doubanHome') {
            resetSearchArea(); 
        }
    }
}

// Wait for Tauri API to be ready before initializing the app
function whenTauriApiReady(callback) {
    // Check if tauriConstants and its invoke method are available
    // tauriConstants is defined in apiUtils.js and should be loaded before app.js
    if (typeof tauriConstants !== 'undefined' && tauriConstants.invoke) {
        console.log("[AppInit] Tauri API (via tauriConstants.invoke) is immediately available.");
        callback();
    } else {
        let attempts = 0;
        const maxAttempts = 100; // Reverted to 10 seconds timeout
        const intervalTime = 100; // Check every 100ms
        console.log("[AppInit] Tauri API (via tauriConstants.invoke) not immediately available. Starting polling...");
        const interval = setInterval(() => {
            attempts++;
            // Simplified logging, closer to what might have been original or less intrusive
            if (attempts === 1 || attempts % 50 === 0 || attempts === maxAttempts) { // Log less frequently
                console.log(`[AppInit Polling Attempt ${attempts}] Checking for tauriConstants.invoke...`);
                if (typeof tauriConstants !== 'undefined' && tauriConstants.invoke) {
                     console.log(`[AppInit Polling Attempt ${attempts}] tauriConstants.invoke is now available.`);
                } else {
                     console.log(`[AppInit Polling Attempt ${attempts}] tauriConstants.invoke is still NOT available.`);
                     // Optionally log window.__TAURI__ status if needed for deeper debugging by user
                     // console.log(`[AppInit Polling Attempt ${attempts}] window.__TAURI__ exists: ${!!window.__TAURI__}`);
                }
            }

            if (typeof tauriConstants !== 'undefined' && tauriConstants.invoke) {
                clearInterval(interval);
                console.log(`[AppInit] Tauri API (via tauriConstants.invoke) became available after ${attempts} attempts.`);
                callback();
            } else if (attempts >= maxAttempts) {
                clearInterval(interval);
                console.error("[AppInit] Tauri API (via tauriConstants.invoke) did not become available after " + (maxAttempts * intervalTime / 1000) + " seconds. App might not function correctly.");
                callback(); 
            }
        }, intervalTime);
    }
}

// 页面初始化
document.addEventListener('DOMContentLoaded', function() {
    console.log("[AppInit] DOMContentLoaded event fired.");
    whenTauriApiReady(initializeApp);
});
