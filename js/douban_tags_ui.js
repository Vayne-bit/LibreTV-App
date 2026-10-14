import { 
    movieTags as coreMovieTags, 
    tvTags as coreTvTags, 
    defaultMovieTags as coreDefaultMovieTags, 
    defaultTvTags as coreDefaultTvTags,
    saveUserTags as coreSaveUserTags
} from './douban_tags_core.js';

// Helper to re-assign to exported let variables from douban_tags_core.js
function updateCoreTags(isMovie, newTags) {
    if (isMovie) {
        coreMovieTags.length = 0; // Clear array
        coreMovieTags.push(...newTags);
    } else {
        coreTvTags.length = 0; // Clear array
        coreTvTags.push(...newTags);
    }
}

/**
 * Renders the Douban tag selector.
 * @param {HTMLElement} tagContainer - The HTML element to render tags into.
 * @param {string} currentActiveMovieTvSwitch - 'movie' or 'tv'.
 * @param {string} currentSelectedTag - The currently selected tag.
 * @param {function} onTagClick - Callback when a tag is clicked: (newTag) => void.
 * @param {function} onManageTagsClick - Callback when manage tags button is clicked: () => void.
 */
export function renderDoubanTagsUI(tagContainer, currentActiveMovieTvSwitch, currentSelectedTag, onTagClick, onManageTagsClick) {
    if (!tagContainer) return;
    
    const currentTagsToDisplay = currentActiveMovieTvSwitch === 'movie' ? coreMovieTags : coreTvTags;
    
    tagContainer.innerHTML = ''; // Clear previous tags

    const manageBtn = document.createElement('button');
    manageBtn.className = 'py-1.5 px-3.5 rounded text-sm font-medium transition-all duration-300 bg-[#1a1a1a] text-gray-300 hover:bg-pink-700 hover:text-white border border-[#333] hover:border-white';
    manageBtn.innerHTML = '<span class="flex items-center"><svg class="w-3 h-3 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>管理标签</span>';
    manageBtn.onclick = onManageTagsClick;
    tagContainer.appendChild(manageBtn);

    currentTagsToDisplay.forEach(tag => {
        const btn = document.createElement('button');
        let btnClass = 'py-1.5 px-3.5 rounded text-sm font-medium transition-all duration-300 border ';
        if (tag === currentSelectedTag) {
            btnClass += 'bg-pink-600 text-white shadow-md border-white';
        } else {
            btnClass += 'bg-[#1a1a1a] text-gray-300 hover:bg-pink-700 hover:text-white border-[#333] hover:border-white';
        }
        btn.className = btnClass;
        btn.textContent = tag;
        btn.onclick = function() {
            if (currentSelectedTag !== tag) {
                onTagClick(tag);
            }
        };
        tagContainer.appendChild(btn);
    });
}

/**
 * Shows the tag management modal.
 * @param {string} currentActiveMovieTvSwitch - 'movie' or 'tv'.
 * @param {function} showToastFn - Function to show toast messages: (message, type) => void.
 * @param {object} callbacks - Object containing callbacks:
 *  - onTagsUpdated: () => void - Called after tags are changed and UI should refresh.
 *  - getCurrentTag: () => string - Returns the current selected tag.
 *  - setCurrentTag: (tag: string) => void - Sets the current selected tag.
 *  - setPageStart: (start: number) => void - Sets the page start for recommendations.
 *  - renderRecommendFn: (tag, pageSize, pageStart) => void - Renders recommendations.
 *  - renderDoubanTagsFn: () => void - Renders the tag list.
 *  - doubanPageSize: number - page size for recommendations
 */
export function showTagManageModalUI(currentActiveMovieTvSwitch, showToastFn, callbacks) {
    let modal = document.getElementById('tagManageModal');
    if (modal) {
        document.body.removeChild(modal);
    }
    
    modal = document.createElement('div');
    modal.id = 'tagManageModal';
    modal.className = 'fixed inset-0 bg-black bg-opacity-75 flex items-center justify-center z-40';
    
    const isMovie = currentActiveMovieTvSwitch === 'movie';
    const currentTags = isMovie ? coreMovieTags : coreTvTags;
    // const defaultTags = isMovie ? coreDefaultMovieTags : coreDefaultTvTags; // Not directly used in modal HTML structure
    
    modal.innerHTML = `
        <div class="bg-[#191919] rounded-lg p-6 max-w-md w-full max-h-[90vh] overflow-y-auto relative">
            <button id="closeTagModal" class="absolute top-4 right-4 text-gray-400 hover:text-white text-xl">&times;</button>
            <h3 class="text-xl font-bold text-white mb-4">标签管理 (${isMovie ? '电影' : '电视剧'})</h3>
            <div class="mb-4">
                <div class="flex justify-between items-center mb-2">
                    <h4 class="text-lg font-medium text-gray-300">标签列表</h4>
                    <button id="resetTagsBtn" class="text-xs px-2 py-1 bg-gray-700 hover:bg-gray-600 text-white rounded">
                        恢复默认标签
                    </button>
                </div>
                <div class="grid grid-cols-2 sm:grid-cols-3 gap-2 mb-4" id="tagsGrid">
                    ${currentTags.length ? currentTags.map(tag => {
                        const canDelete = tag !== '热门';
                        return `
                            <div class="bg-[#1a1a1a] text-gray-300 py-1.5 px-3 rounded text-sm font-medium flex justify-between items-center group">
                                <span>${tag.replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"')}</span>
                                ${canDelete ? 
                                    `<button class="delete-tag-btn text-gray-500 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity" 
                                        data-tag="${tag}">✕</button>` : 
                                    `<span class="text-gray-500 text-xs italic opacity-0 group-hover:opacity-100">必需</span>`
                                }
                            </div>
                        `;
                    }).join('') : 
                    `<div class="col-span-full text-center py-4 text-gray-500">无标签，请添加或恢复默认</div>`}
                </div>
            </div>
            <div class="border-t border-gray-700 pt-4">
                <h4 class="text-lg font-medium text-gray-300 mb-3">添加新标签</h4>
                <form id="addTagForm" class="flex items-center">
                    <input type="text" id="newTagInput" placeholder="输入标签名称..." 
                           class="flex-1 bg-[#222] text-white border border-gray-700 rounded px-3 py-2 focus:outline-none focus:border-pink-500">
                    <button type="submit" class="ml-2 bg-pink-600 hover:bg-pink-700 text-white px-4 py-2 rounded">添加</button>
                </form>
                <p class="text-xs text-gray-500 mt-2">提示：标签名称不能为空，不能重复，不能包含特殊字符</p>
            </div>
        </div>
    `;
    
    document.body.appendChild(modal);
    
    setTimeout(() => {
        document.getElementById('newTagInput')?.focus();
    }, 100);
    
    document.getElementById('closeTagModal')?.addEventListener('click', () => document.body.removeChild(modal));
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    });
    
    document.getElementById('resetTagsBtn')?.addEventListener('click', () => {
        resetTagsToDefaultUI(currentActiveMovieTvSwitch, showToastFn, callbacks);
        // Re-render modal or close and re-open: For simplicity, close and let user re-open if needed, or re-call showTagManageModalUI
        document.body.removeChild(modal); // Close current modal
        showTagManageModalUI(currentActiveMovieTvSwitch, showToastFn, callbacks); // Re-open with updated tags
    });
    
    document.querySelectorAll('.delete-tag-btn').forEach(btn => {
        btn.addEventListener('click', function() {
            const tagToDelete = this.getAttribute('data-tag');
            deleteTagUI(tagToDelete, currentActiveMovieTvSwitch, showToastFn, callbacks);
            document.body.removeChild(modal);
            showTagManageModalUI(currentActiveMovieTvSwitch, showToastFn, callbacks);
        });
    });
    
    document.getElementById('addTagForm')?.addEventListener('submit', (e) => {
        e.preventDefault();
        const input = document.getElementById('newTagInput');
        const newTag = input.value.trim();
        if (newTag) {
            addTagUI(newTag, currentActiveMovieTvSwitch, showToastFn, callbacks);
            input.value = '';
            document.body.removeChild(modal);
            showTagManageModalUI(currentActiveMovieTvSwitch, showToastFn, callbacks);
        }
    });
}

function addTagUI(tag, currentActiveMovieTvSwitch, showToastFn, callbacks) {
    const safeTag = tag.replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"');
    const isMovie = currentActiveMovieTvSwitch === 'movie';
    const currentTags = isMovie ? [...coreMovieTags] : [...coreTvTags];
    
    if (currentTags.some(existingTag => existingTag.toLowerCase() === safeTag.toLowerCase())) {
        showToastFn('标签已存在', 'warning');
        return;
    }
    
    currentTags.push(safeTag);
    updateCoreTags(isMovie, currentTags);
    
    try {
        coreSaveUserTags();
        showToastFn('标签添加成功', 'success');
    } catch(e) {
        console.error("Failed to save tags from addTagUI", e);
        showToastFn('保存标签失败', 'error');
    }
    callbacks.onTagsUpdated(); // This will trigger renderDoubanTags in douban.js
}

function deleteTagUI(tag, currentActiveMovieTvSwitch, showToastFn, callbacks) {
    if (tag === '热门') {
        showToastFn('热门标签不能删除', 'warning');
        return;
    }
    
    const isMovie = currentActiveMovieTvSwitch === 'movie';
    let currentTags = isMovie ? [...coreMovieTags] : [...coreTvTags];
    const index = currentTags.indexOf(tag);
    
    if (index !== -1) {
        currentTags.splice(index, 1);
        updateCoreTags(isMovie, currentTags);

        try {
            coreSaveUserTags();
            showToastFn('标签删除成功', 'success');
        } catch(e) {
            console.error("Failed to save tags from deleteTagUI", e);
            showToastFn('保存标签失败', 'error');
        }
        
        if (callbacks.getCurrentTag() === tag) {
            callbacks.setCurrentTag('热门');
            callbacks.setPageStart(0);
            callbacks.renderRecommendFn('热门', callbacks.doubanPageSize, 0);
        }
        callbacks.onTagsUpdated();
    }
}

function resetTagsToDefaultUI(currentActiveMovieTvSwitch, showToastFn, callbacks) {
    const isMovie = currentActiveMovieTvSwitch === 'movie';
    
    if (isMovie) {
        updateCoreTags(true, [...coreDefaultMovieTags]);
    } else {
        updateCoreTags(false, [...coreDefaultTvTags]);
    }
    
    try {
        coreSaveUserTags();
        showToastFn('已恢复默认标签', 'success');
    } catch(e) {
        console.error("Failed to save tags from resetTagsToDefaultUI", e);
        showToastFn('保存标签失败', 'error');
    }

    callbacks.setCurrentTag('热门');
    callbacks.setPageStart(0);
    callbacks.renderRecommendFn('热门', callbacks.doubanPageSize, 0);
    callbacks.onTagsUpdated();
}
