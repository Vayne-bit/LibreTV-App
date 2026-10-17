// 清晰度显示：优先用探测到的真实分辨率，探测不到回退到备注关键词并标注来源

// 备注里常见的画质关键词，按从高到低匹配
const QUALITY_KEYWORD_PATTERNS = [
    { label: '4K', re: /(?:^|[^0-9A-Za-z])(4K|2160P|UHD|超高清)(?:[^0-9A-Za-z]|$)/i },
    { label: '1080P', re: /(?:^|[^0-9A-Za-z])(1080P|FHD|全高清|蓝光)(?:[^0-9A-Za-z]|$)/i },
    { label: '720P', re: /(?:^|[^0-9A-Za-z])(720P|高清|HD)(?:[^0-9A-Za-z]|$)/i },
    { label: '480P', re: /(?:^|[^0-9A-Za-z])(480P|标清|SD)(?:[^0-9A-Za-z]|$)/i }
];

// 把宽高格式化成 1920×1080 这种精确写法
function formatResolution(width, height) {
    const w = Math.round(Number(width) || 0);
    const h = Math.round(Number(height) || 0);
    if (!w || !h) return '';
    return `${w}×${h}`;
}

// 按宽度判定档位：宽银幕影片高度不足 1080，按高度判会误标低一档
function formatResolutionShort(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (!w && !h) return '';
    if (w >= 3400 || h >= 2000) return '4K';
    if (w >= 1800 || h >= 1000) return '1080P';
    if (w >= 1150 || h >= 650) return '720P';
    if (w >= 800 || h >= 460) return '480P';
    return `${Math.round(h) || Math.round(w)}P`;
}

// 兼容旧调用名
function formatResolutionLabel(width, height) {
    return formatResolutionShort(width, height);
}

// 从整条分辨率记录里取要显示的文字
// 返回 { text, fromKeyword }：fromKeyword 为 true 表示这是备注推测值，不是实测值
function resolutionDisplayOf(source) {
    if (!source) return { text: '', fromKeyword: false };
    const res = source.resolution;
    if (res && res.width && res.height) {
        return { text: formatResolution(res.width, res.height), fromKeyword: false };
    }
    const keyword = deriveQualityKeyword(source.remarks || '');
    return keyword ? { text: keyword, fromKeyword: true } : { text: '', fromKeyword: false };
}

// 从备注文本猜画质档位，拿不到返回空
function deriveQualityKeyword(text) {
    const value = String(text || '');
    if (!value) return '';
    for (const pattern of QUALITY_KEYWORD_PATTERNS) {
        if (pattern.re.test(value)) return pattern.label;
    }
    return '';
}

// 兼容旧调用名
function parseQualityFromText(text) {
    return deriveQualityKeyword(text);
}

// 从线路地址里找明确的分辨率线索
function deriveQualityFromUrls(episodes) {
    const text = Array.isArray(episodes) ? episodes.slice(0, 3).join(' ') : '';
    if (!text) return '';
    const match = text.match(/(?:^|[^0-9])(2160|1080|720|480)P?(?:[^0-9]|$)/i);
    if (!match) return '';
    const width = { '2160': 3840, '1080': 1920, '720': 1280, '480': 854 }[match[1]];
    return width ? formatResolutionShort(width, Number(match[1])) : '';
}

// 通过 Rust 命令读取 m3u8 的 master playlist，拿到真实分辨率
async function probeM3u8Resolution(url, timeoutSecs) {
    if (!url || !/^https?:/i.test(url)) return null;
    try {
        const result = await tauriInvoke('probe_m3u8_resolution', {
            url,
            timeoutSecs: timeoutSecs || 6
        });
        if (result && result.ok && result.width && result.height) {
            return { width: result.width, height: result.height };
        }
    } catch (e) { /* 探测失败按无数据处理 */ }
    return null;
}

// 兼容旧名：返回要显示的清晰度文字
function detectQualityLabel(item) {
    return resolutionDisplayOf(item).text;
}
