// 设置事件监听器
function setupEventListeners() {
    // 回车搜索
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('keypress', function(e) {
            if (e.key === 'Enter') {
                search();
            }
        });
    }
    
    // 黄色内容过滤开关事件绑定
    const yellowFilterToggle = document.getElementById('yellowFilterToggle');
    if (yellowFilterToggle) {
        yellowFilterToggle.addEventListener('change', function(e) {
            localStorage.setItem('yellowFilterEnabled', e.target.checked);

            // 控制黄色内容接口的显示状态
            const adultdiv = document.getElementById('adultdiv');
            if (adultdiv) {
                if (e.target.checked === true) {
                    adultdiv.style.display = 'none';
                } else if (e.target.checked === false) {
                    adultdiv.style.display = ''
                }
            } else {
                // 添加成人API列表
                addAdultAPI();
            }
        });
    }
    
    // 广告过滤开关事件绑定
    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
        adFilterToggle.addEventListener('change', function(e) {
            localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, e.target.checked);
        });
    }

    // 豆瓣API模式开关事件绑定
    const doubanApiModeToggle = document.getElementById('doubanApiModeToggle');
    if (doubanApiModeToggle) {
        doubanApiModeToggle.addEventListener('change', function(e) {
            const isChecked = e.target.checked;
            localStorage.setItem('doubanApiMode', isChecked); // Stores "true" or "false" as strings

            const toggleBg = e.target.nextElementSibling;
            const toggleDot = toggleBg ? toggleBg.nextElementSibling : null;
            if (toggleBg && toggleDot) {
                if (isChecked) {
                    toggleBg.classList.add('bg-pink-600');
                    toggleDot.classList.add('translate-x-6');
                } else {
                    toggleBg.classList.remove('bg-pink-600');
                    toggleDot.classList.remove('translate-x-6');
                }
            }
            // Clear home page state from sessionStorage to force re-initialization on next visit
            sessionStorage.removeItem('homePageState'); // Key for home page structure/scroll

            // Clear Douban API data caches from sessionStorage
            for (let i = 0; i < sessionStorage.length; i++) {
                const key = sessionStorage.key(i);
                if (key && key.startsWith('douban_api_cache_')) {
                    sessionStorage.removeItem(key);
                    i--; // Adjust index because sessionStorage.length changes
                }
            }
            showToast('豆瓣API模式已更新。相关内容将在下次访问时刷新以应用更改。', 'info');
        });
    }
}

// 重置搜索区域 (Now primarily means navigating to home tab)
function resetSearchArea() {
    if (typeof navigateToTab === 'function') {
        navigateToTab('home');
    } else {
        console.warn('navigateToTab function not found for resetSearchArea');
        // Fallback or legacy behavior if navigateToTab is not available yet
        // This part might become obsolete once navigateToTab is fully integrated.
        const searchResultsEl = document.getElementById('results');
        if (searchResultsEl) searchResultsEl.innerHTML = '';
        
        const searchInputEl = document.getElementById('searchInput');
        if (searchInputEl) searchInputEl.value = '';
        
        const searchAreaEl = document.getElementById('searchArea');
        if (searchAreaEl) {
             searchAreaEl.classList.add('flex-1'); // This might be specific to old layout
             searchAreaEl.classList.remove('mb-8'); // This might be specific to old layout
        }
       
        const resultsAreaEl = document.getElementById('resultsArea');
        if (resultsAreaEl) resultsAreaEl.classList.add('hidden');
        
        sessionStorage.setItem('lastPageView', 'doubanHome'); // Or simply 'home'
    }
    
    // Douban visibility is handled by navigateToTab('home') and initDouban logic
    if (typeof updateDoubanVisibility === 'function') {
        // updateDoubanVisibility(); // This might be redundant if navigateToTab handles it
    }
}
