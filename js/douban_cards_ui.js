// Assuming PROXY_URL and fillAndSearchWithDouban are passed as arguments.

/**
 * Renders Douban recommendation cards into the specified container.
 * @param {object} data - The data object from the Douban API, expected to have a `subjects` array.
 * @param {HTMLElement} container - The HTML element to render the cards into.
 * @param {string} proxyUrl - The base URL for the proxy service (for image fallbacks).
 * @param {function} onCardClickCallback - Callback function when a card is clicked, e.g., fillAndSearchWithDouban(title).
 */
export function renderDoubanCardsUI(data, container, proxyUrl, onCardClickCallback) {
    const fragment = document.createDocumentFragment();

    if (!data.subjects || data.subjects.length === 0) {
        const emptyEl = document.createElement("div");
        emptyEl.className = "col-span-full text-center py-8";
        emptyEl.innerHTML = `
            <div class="text-pink-500">❌ 暂无数据，请尝试其他分类或刷新</div>
        `;
        fragment.appendChild(emptyEl);
    } else {
        data.subjects.forEach(item => {
            const card = document.createElement("div");
            card.className = "bg-[#111] hover:bg-[#222] transition-all duration-300 rounded-lg overflow-hidden flex flex-col transform hover:scale-105 shadow-md hover:shadow-lg";
            
            // Correct XSS sanitization
            const safeTitle = String(item.title)
                .replace(/&/g, '&')
                .replace(/</g, '<')
                .replace(/>/g, '>')
                .replace(/"/g, '"')
                .replace(/'/g, '&#039;');
            
            const safeRate = String(item.rate || "暂无")
                .replace(/&/g, '&')
                .replace(/</g, '<')
                .replace(/>/g, '>')
                .replace(/"/g, '"')
                .replace(/'/g, '&#039;');
            
            const originalCoverUrl = item.cover;
            const proxiedCoverUrl = proxyUrl + encodeURIComponent(originalCoverUrl);
            
            card.innerHTML = `
                <div class="relative w-full aspect-[2/3] overflow-hidden cursor-pointer">
                    <img src="${originalCoverUrl}" alt="${safeTitle}" 
                        class="w-full h-full object-cover transition-transform duration-500 hover:scale-110"
                        onerror="this.onerror=null; this.src='${proxiedCoverUrl}'; this.classList.add('object-contain');"
                        loading="lazy" referrerpolicy="no-referrer">
                    <div class="absolute inset-0 bg-gradient-to-t from-black to-transparent opacity-60"></div>
                    <div class="absolute bottom-2 left-2 bg-black/70 text-white text-xs px-2 py-1 rounded-sm">
                        <span class="text-yellow-400">★</span> ${safeRate}
                    </div>
                    <div class="absolute bottom-2 right-2 bg-black/70 text-white text-xs px-2 py-1 rounded-sm hover:bg-[#333] transition-colors">
                        <a href="${item.url}" target="_blank" rel="noopener noreferrer" title="在豆瓣查看" onclick="event.stopPropagation();">
                            🔗
                        </a>
                    </div>
                </div>
                <div class="p-2 text-center bg-[#111]">
                    <button class="text-sm font-medium text-white truncate w-full hover:text-pink-400 transition"
                            title="${safeTitle}">
                        ${safeTitle}
                    </button>
                </div>
            `;
            
            // Attach click handlers more robustly
            const clickableImgArea = card.querySelector('.aspect-\\[2\\/3\\]');
            if (clickableImgArea) {
                clickableImgArea.onclick = () => onCardClickCallback(safeTitle);
            }
            const clickableButton = card.querySelector('.p-2 button');
            if (clickableButton) {
                clickableButton.onclick = () => onCardClickCallback(safeTitle);
            }
            
            fragment.appendChild(card);
        });
    }
    
    container.innerHTML = ""; // Clear previous content
    container.appendChild(fragment);
}
