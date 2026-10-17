// 清晰度显示：优先使用探测到的真实分辨率，取不到就如实留空，不做猜测

// 把宽高格式化成 1920×1080 这种精确写法
function formatResolution(width, height) {
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (!w || !h) return '';
    return `${w}×${h}`;
}

// 判断常见档位的口头叫法，仅在需要简称时使用
function formatResolutionShort(width, height) {
    const h = Number(height) || 0;
    if (!h) return '';
    if (h >= 2000) return '4K';
    if (h >= 1000) return '1080P';
    if (h >= 700) return '720P';
    if (h >= 460) return '480P';
    return `${h}P`;
}

// 兼容旧调用
function formatResolutionLabel(width, height) {
    return formatResolutionShort(width, height);
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

// 兼容旧名，返回精确分辨率字符串
function detectQualityLabel(item) {
    if (!item || !item.resolution) return '';
    return formatResolution(item.resolution.width, item.resolution.height);
}
