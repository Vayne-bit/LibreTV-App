// 清晰度标记解析与格式化：从 vod_remarks 中提取画质，并联合 vod_play_url 判断

// 常见画质标记，按优先级从高到低匹配
const QUALITY_PATTERNS = [
    { label: '4K', re: /(?:^|[^0-9A-Za-z])(4K|2160P|UHD|超高清)(?:[^0-9A-Za-z]|$)/i },
    { label: '1080P', re: /(?:^|[^0-9A-Za-z])(1080P|FHD|全高清|蓝光)(?:[^0-9A-Za-z]|$)/i },
    { label: '720P', re: /(?:^|[^0-9A-Za-z])(720P|高清|HD)(?:[^0-9A-Za-z]|$)/i },
    { label: '480P', re: /(?:^|[^0-9A-Za-z])(480P|标清|SD)(?:[^0-9A-Za-z]|$)/i }
];

// vod_remarks 是自由文本，各源写法混乱，这里只做保守的启发式提取
function parseQualityFromText(text) {
    const value = String(text || '');
    if (!value) return '';
    for (const pattern of QUALITY_PATTERNS) {
        if (pattern.re.test(value)) return pattern.label;
    }
    return '';
}

// 备注里没有画质时，看看线路地址是否带了明确的分辨率线索
function parseQualityFromUrls(episodes) {
    const text = Array.isArray(episodes) ? episodes.slice(0, 3).join(' ') : '';
    if (!text) return '';
    const match = text.match(/(?:^|[^0-9])(2160|1080|720|480)P?(?:[^0-9]|$)/i);
    if (!match) return '';
    const height = match[1];
    if (height === '2160') return '4K';
    if (height === '1080') return '1080P';
    if (height === '720') return '720P';
    if (height === '480') return '480P';
    return '';
}

// 依次尝试：备注文本 → 线路地址；都取不到返回空字符串
function detectQualityLabel(item) {
    if (!item) return '';
    return parseQualityFromText(item.remarks || item.vod_remarks)
        || parseQualityFromUrls(item.episodes);
}

// 把视频真实像素高度格式化成 1080P / 720P 这种标记
function formatResolutionLabel(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (!h) return '';
    if (h >= 2000) return '4K';
    if (h >= 1000) return '1080P';
    if (h >= 700) return '720P';
    if (h >= 460) return '480P';
    return `${h}P`;
}
