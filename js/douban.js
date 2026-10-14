// 豆瓣热门电影电视剧推荐功能
import { 
    // defaultMovieTags, // No longer directly used here, core module handles them
    // defaultTvTags,   // No longer directly used here
    movieTags,      // Used for read-only purposes if needed, or passed by UI module
    tvTags,         // Used for read-only purposes if needed, or passed by UI module
    loadUserTags, 
    // saveUserTags as coreSaveUserTags // UI module now calls this directly
} from './douban_tags_core.js';

import { 
    renderDoubanTagsUI, 
    showTagManageModalUI 
} from './douban_tags_ui.js';

import { fetchDoubanApiData } from './douban_api.js';
import { renderDoubanCardsUI } from './douban_cards_ui.js';

// The saveUserTags wrapper is no longer needed here as UI functions handle saving and toast.

// Assuming PROXY_URL is defined globally in the scope where douban.js runs
// For example, in a script tag before this module, or in a config.js file.
// const PROXY_URL = '/api/proxy?url='; // Example, ensure this is defined.

let doubanMovieTvCurrentSwitch = 'movie';
let doubanCurrentTag = '热门';
let doubanPageStart = 0;
const doubanPageSize = 16; // 一次显示的项目数量

// 初始化豆瓣功能
function initDouban() {
    // 设置豆瓣开关的初始状态
    const doubanToggle = document.getElementById('doubanToggle');
    if (doubanToggle) {
        const isEnabled = localStorage.getItem('doubanEnabled') === 'true';
        doubanToggle.checked = isEnabled;
        
        // 设置开关外观
        const toggleBg = doubanToggle.nextElementSibling;
        const toggleDot = toggleBg.nextElementSibling;
        if (isEnabled) {
            toggleBg.classList.add('bg-pink-600');
            toggleDot.classList.add('translate-x-6');
        }
        
        // 添加事件监听
        doubanToggle.addEventListener('change', function(e) {
            const isChecked = e.target.checked;
            localStorage.setItem('doubanEnabled', isChecked);
            
            // 更新开关外观
            if (isChecked) {
                toggleBg.classList.add('bg-pink-600');
                toggleDot.classList.add('translate-x-6');
            } else {
                toggleBg.classList.remove('bg-pink-600');
                toggleDot.classList.remove('translate-x-6');
            }
            
            // 更新显示状态
            updateDoubanVisibility();
        });
        
        // 初始更新显示状态
        updateDoubanVisibility();

        // 滚动到页面顶部
        window.scrollTo(0, 0);
    }

    // 加载用户标签
    loadUserTags(); // Loads into coreMovieTags, coreTvTags

    // 渲染电影/电视剧切换
    renderDoubanMovieTvSwitch();
    
    // 渲染豆瓣标签
    renderDoubanTags(); // This will now call the UI version
    
    // 换一批按钮事件监听
    setupDoubanRefreshBtn();
    
    // 初始加载热门内容
    if (localStorage.getItem('doubanEnabled') === 'true') {
        renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
    }
}

// 根据设置更新豆瓣区域的显示状态
function updateDoubanVisibility() {
    const doubanArea = document.getElementById('doubanArea');
    if (!doubanArea) return;
    
    const isEnabled = localStorage.getItem('doubanEnabled') === 'true';
    const isSearching = document.getElementById('resultsArea') && 
        !document.getElementById('resultsArea').classList.contains('hidden');
    
    // 只有在启用且没有搜索结果显示时才显示豆瓣区域
    if (isEnabled && !isSearching) {
        doubanArea.classList.remove('hidden');
        // 如果豆瓣结果为空，重新加载
        if (document.getElementById('douban-results').children.length === 0) {
            renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
        }
    } else {
        doubanArea.classList.add('hidden');
    }
}

// 只填充搜索框，不执行搜索，让用户自主决定搜索时机
function fillSearchInput(title) {
    if (!title) return;
    
    // 安全处理标题，防止XSS
    const safeTitle = title
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = safeTitle;
        
        // 聚焦搜索框，便于用户立即使用键盘操作
        input.focus();
        
        // 显示一个提示，告知用户点击搜索按钮进行搜索
        showToast('已填充搜索内容，点击搜索按钮开始搜索', 'info');
    }
}

// 填充搜索框并执行搜索
function fillAndSearch(title) {
    if (!title) return;
    
    // 安全处理标题，防止XSS
    const safeTitle = title
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = safeTitle;
        search(); // 使用已有的search函数执行搜索
    }
}

// 填充搜索框，确保豆瓣资源API被选中，然后执行搜索
async function fillAndSearchWithDouban(title) {
    if (!title) return;
    
    // 安全处理标题，防止XSS
    const safeTitle = title
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    
    // 确保豆瓣资源API被选中
    if (typeof selectedAPIs !== 'undefined' && !selectedAPIs.includes('dbzy')) {
        // 在设置中勾选豆瓣资源API复选框
        const doubanCheckbox = document.querySelector('input[id="api_dbzy"]');
        if (doubanCheckbox) {
            doubanCheckbox.checked = true;
            
            // 触发updateSelectedAPIs函数以更新状态
            if (typeof updateSelectedAPIs === 'function') {
                updateSelectedAPIs();
            } else {
                // 如果函数不可用，则手动添加到selectedAPIs
                selectedAPIs.push('dbzy');
                localStorage.setItem('selectedAPIs', JSON.stringify(selectedAPIs));
                
                // 更新选中API计数（如果有这个元素）
                const countEl = document.getElementById('selectedAPICount');
                if (countEl) {
                    countEl.textContent = selectedAPIs.length;
                }
            }
            
            showToast('已自动选择豆瓣资源API', 'info');
        }
    }
    
    // 填充搜索框并执行搜索
    const input = document.getElementById('searchInput');
    if (input) {
        input.value = safeTitle;
        await search(); // 使用已有的search函数执行搜索

        if (window.innerWidth <= 768) {
          window.scrollTo({
              top: 0,
              behavior: 'smooth'
          });
        }
    }
}

// 渲染电影/电视剧切换器
function renderDoubanMovieTvSwitch() {
    // 获取切换按钮元素
    const movieToggle = document.getElementById('douban-movie-toggle');
    const tvToggle = document.getElementById('douban-tv-toggle');

    if (!movieToggle ||!tvToggle) return;

    movieToggle.addEventListener('click', function() {
        if (doubanMovieTvCurrentSwitch !== 'movie') {
            // 更新按钮样式
            movieToggle.classList.add('bg-pink-600', 'text-white');
            movieToggle.classList.remove('text-gray-300');
            
            tvToggle.classList.remove('bg-pink-600', 'text-white');
            tvToggle.classList.add('text-gray-300');
            
            doubanMovieTvCurrentSwitch = 'movie';
            doubanCurrentTag = '热门'; // Reset current tag
            doubanPageStart = 0; // Reset page start

            // 重新加载豆瓣内容
            renderDoubanTags(); // Re-render tags for the new type

            // setupDoubanRefreshBtn(); // Already set up in initDouban, no need to re-setup
            
            // 初始加载热门内容
            if (localStorage.getItem('doubanEnabled') === 'true') {
                renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
            }
        }
    });
    
    // 电视剧按钮点击事件
    tvToggle.addEventListener('click', function() {
        if (doubanMovieTvCurrentSwitch !== 'tv') {
            // 更新按钮样式
            tvToggle.classList.add('bg-pink-600', 'text-white');
            tvToggle.classList.remove('text-gray-300');
            
            movieToggle.classList.remove('bg-pink-600', 'text-white');
            movieToggle.classList.add('text-gray-300');
            
            doubanMovieTvCurrentSwitch = 'tv';
            doubanCurrentTag = '热门'; // Reset current tag
            doubanPageStart = 0; // Reset page start

            // 重新加载豆瓣内容
            renderDoubanTags(); // Re-render tags for the new type

            // setupDoubanRefreshBtn(); // Already set up in initDouban
            
            // 初始加载热门内容
            if (localStorage.getItem('doubanEnabled') === 'true') {
                renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
            }
        }
    });
}

// Wrapper function in douban.js to call the UI function
function renderDoubanTags() {
    const tagContainer = document.getElementById('douban-tags');
    if (!tagContainer) return;

    renderDoubanTagsUI(
        tagContainer,
        doubanMovieTvCurrentSwitch,
        doubanCurrentTag,
        (newTag) => { // onTagClick
            doubanCurrentTag = newTag;
            doubanPageStart = 0;
            renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
            renderDoubanTags(); // Re-render to update active tag style
        },
        () => { // onManageTagsClick
            showTagManageModal();
        }
    );
}

// 设置换一批按钮事件
function setupDoubanRefreshBtn() {
    // 修复ID，使用正确的ID douban-refresh 而不是 douban-refresh-btn
    const btn = document.getElementById('douban-refresh');
    if (!btn) return;
    
    btn.onclick = function() {
        doubanPageStart += doubanPageSize;
        if (doubanPageStart > 9 * doubanPageSize) {
            doubanPageStart = 0;
        }
        
        renderRecommend(doubanCurrentTag, doubanPageSize, doubanPageStart);
    };
}

function fetchDoubanTags() {
    const movieTagsTarget = `https://movie.douban.com/j/search_tags?type=movie`
    fetchDoubanApiData(movieTagsTarget, PROXY_URL) // Use new API function
        .then(data => {
            // movieTags are now in douban_tags_core.js and managed by douban_tags_ui.js
            // This function might be for fetching initial remote tags, not user tags.
            // For now, assuming this function's purpose might need re-evaluation
            // or that it should update the core tags.
            // If these are meant to be *additional* tags from Douban API:
            // console.log("Fetched movie tags from Douban API:", data.tags);
            // Potentially merge with coreMovieTags or offer to user.
            // For now, let's assume it's not critical for the current refactor stage of user tags.
            // If it IS for overwriting user tags with fresh ones:
            // movieTags.length = 0; movieTags.push(...data.tags); coreSaveUserTags();
            if (doubanMovieTvCurrentSwitch === 'movie') {
                // This would overwrite user's tags if not handled carefully.
                // Let's assume this function is for something else or needs adjustment.
                // renderDoubanTags(); // Re-render if tags changed
            }
        })
        .catch(error => {
            console.error("获取豆瓣热门电影标签失败：", error);
        });
    const tvTagsTarget = `https://movie.douban.com/j/search_tags?type=tv`
    fetchDoubanApiData(tvTagsTarget, PROXY_URL) // Use new API function
       .then(data => {
            // Similar to movieTags above.
            // console.log("Fetched TV tags from Douban API:", data.tags);
            if (doubanMovieTvCurrentSwitch === 'tv') {
                // renderDoubanTags();
            }
        })
       .catch(error => {
            console.error("获取豆瓣热门电视剧标签失败：", error);
        });
}

// 渲染热门推荐内容
// Make renderRecommend exportable or ensure it's in scope for callbacks
/* export */ function renderRecommend(tag, pageLimit, pageStart) {
    const container = document.getElementById("douban-results");
    if (!container) return;

    const loadingOverlayHTML = `
        <div class="absolute inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-10">
            <div class="flex items-center justify-center">
                <div class="w-6 h-6 border-2 border-pink-500 border-t-transparent rounded-full animate-spin inline-block"></div>
                <span class="text-pink-500 ml-4">加载中...</span>
            </div>
        </div>
    `;

    container.classList.add("relative");
    container.insertAdjacentHTML('beforeend', loadingOverlayHTML);
    
    const target = `https://movie.douban.com/j/search_subjects?type=${doubanMovieTvCurrentSwitch}&tag=${tag}&sort=recommend&page_limit=${pageLimit}&page_start=${pageStart}`;
    
    // 使用新的API函数
    fetchDoubanApiData(target, PROXY_URL)
        .then(data => {
            // Call the new UI function for rendering cards
            renderDoubanCardsUI(data, container, PROXY_URL, fillAndSearchWithDouban);
        })
        .catch(error => {
            console.error("获取豆瓣数据失败：", error);
            container.innerHTML = `
                <div class="col-span-full text-center py-8">
                    <div class="text-red-400">❌ 获取豆瓣数据失败，请稍后重试</div>
                    <div class="text-gray-500 text-sm mt-2">提示：使用VPN可能有助于解决此问题</div>
                </div>
            `;
        });
}

// The original fetchDoubanData function is now removed and replaced by fetchDoubanApiData from douban_api.js
// The original renderDoubanCards function is now removed and replaced by renderDoubanCardsUI from douban_cards_ui.js

// 重置到首页
function resetToHome() {
    resetSearchArea();
    updateDoubanVisibility();
}

// 加载豆瓣首页内容
document.addEventListener('DOMContentLoaded', initDouban);

// Wrapper function in douban.js to call the UI function for the modal
function showTagManageModal() {
    // Ensure showToast is accessible, assuming it's a global function
    // or pass it explicitly if it's not.
    const callbacks = {
        onTagsUpdated: () => {
            renderDoubanTags(); // Re-render the main tag list
        },
        getCurrentTag: () => doubanCurrentTag,
        setCurrentTag: (tag) => { doubanCurrentTag = tag; },
        setPageStart: (start) => { doubanPageStart = start; },
        renderRecommendFn: renderRecommend, // Pass the actual renderRecommend function
        renderDoubanTagsFn: renderDoubanTags, // Pass the main renderDoubanTags wrapper
        doubanPageSize: doubanPageSize
    };

    showTagManageModalUI(
        doubanMovieTvCurrentSwitch,
        showToast, // Pass the showToast function
        callbacks
    );
}

// Functions addTag, deleteTag, resetTagsToDefault are now part of douban_tags_ui.js
// and are invoked internally by the modal logic there.
// They use coreSaveUserTags and the passed showToastFn.
