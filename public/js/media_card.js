// Poster card renderers shared by home feed, category grid and search results

function posterCardHtml(item) {
    const attrs = Object.entries(item.attrs || {})
        .map(([key, value]) => `data-${key}="${escapeHtml(value)}"`)
        .join(' ');
    return `<button type="button" class="poster-card" ${attrs} title="${escapeHtml(item.title)}">
        <div class="poster-thumb">
            ${posterImgHtml(item.cover, item.title)}
            ${item.rating ? `<span class="poster-rating">${escapeHtml(item.rating)}</span>` : ''}
            ${item.badge ? `<span class="poster-badge">${escapeHtml(item.badge)}</span>` : ''}
        </div>
        <div class="poster-title">${escapeHtml(item.title)}</div>
        ${item.subtitle ? `<div class="poster-sub">${escapeHtml(item.subtitle)}</div>` : ''}
    </button>`;
}

function doubanCardHtml(subject) {
    const rate = subject.rate && subject.rate !== '0' ? subject.rate : '';
    return posterCardHtml({
        title: subject.title || '',
        cover: subject.cover || '',
        rating: rate,
        badge: subject.episodes_info || (subject.is_new ? '新上线' : ''),
        subtitle: subject.subtitle || '',
        attrs: { card: 'douban', title: subject.title || '' }
    });
}

function vodCardHtml(item, { showSource = false } = {}) {
    return posterCardHtml({
        title: item.vod_name || '',
        cover: item.vod_pic || '',
        badge: item.vod_remarks || '',
        subtitle: [showSource ? item.source_name : item.type_name, item.vod_year].filter(Boolean).join(' · '),
        attrs: {
            card: 'vod',
            id: item.vod_id || '',
            source: item.source_code || '',
            title: item.vod_name || '',
            'api-url': item.api_url || ''
        }
    });
}

function vodGroupCardHtml(items, key) {
    const first = items[0];
    const withCover = items.find(item => item.vod_pic) || first;
    return posterCardHtml({
        title: first.vod_name || '',
        cover: withCover.vod_pic || '',
        badge: `${items.length} 个源`,
        subtitle: [first.type_name, first.vod_year].filter(Boolean).join(' · '),
        attrs: { card: 'vodgroup', key, title: first.vod_name || '' }
    });
}

function skeletonCardsHtml(count) {
    return Array.from({ length: count }, () => `
        <div class="poster-card skeleton" aria-hidden="true">
            <div class="poster-thumb"></div>
            <div class="poster-title">&nbsp;</div>
        </div>`).join('');
}
