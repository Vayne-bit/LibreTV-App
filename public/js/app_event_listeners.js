// 设置事件监听器
function setupEventListeners() {
    // 回车搜索
    const searchInput = document.getElementById('searchInput');
    if (searchInput) {
        searchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !e.isComposing) {
                if (typeof search === 'function') search(); else console.error("search function not found for Enter key press");
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
                    adultdiv.style.display = ''; // Reset to default display
                }
            } else {
                // If adultdiv doesn't exist, try to add it (might be hidden initially)
                if (typeof addAdultAPI === 'function') addAdultAPI(); else console.error("addAdultAPI function not found");
            }
             // Re-check adult API selections as filter state change might affect this
            if (typeof checkAdultAPIsSelected === 'function') checkAdultAPIsSelected(); else console.error("checkAdultAPIsSelected function not found");
        });
    }
    
    // 广告过滤开关事件绑定
    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
        adFilterToggle.addEventListener('change', function(e) {
            // Assuming PLAYER_CONFIG is global or defined elsewhere
            localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, e.target.checked);
        });
    }

    // 豆瓣热门推荐开关
    const doubanToggle = document.getElementById('doubanToggle');
    if (doubanToggle) {
        doubanToggle.addEventListener('change', function(e) {
            localStorage.setItem('doubanEnabled', e.target.checked);
            if (typeof refreshHomeFeed === 'function') refreshHomeFeed();
        });
    }
}

// 重置搜索区域
function resetSearchArea() {
    if (typeof resetSearchResults === 'function') resetSearchResults();
    const searchInputEl = document.getElementById('searchInput');
    if (searchInputEl) searchInputEl.value = '';
    window.location.hash = '#home';
}
