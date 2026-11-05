// ============ 歌词：LRC 解析 + 同步高亮 ============

const musicLyrics = {
    lines: [],       // [{ time, text }] 已按时间排序
    activeIndex: -1,
    container: null
};

// 解析 LRC：[mm:ss.xx] 行 + 多时间戳行；忽略 offset 之外不认识的标签
function parseLrcText(raw) {
    const lines = [];
    String(raw || '').split(/\r?\n/).forEach(line => {
        const stamps = [...line.matchAll(/\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
        if (!stamps.length) return;
        const text = line.replace(/\[[^\]]*\]/g, '').trim();
        stamps.forEach(m => {
            const t = (parseInt(m[1], 10) * 60) + parseInt(m[2], 10)
                + (m[3] ? parseInt(m[3].padEnd(3, '0'), 10) / 1000 : 0);
            lines.push({ time: t, text });
        });
    });
    lines.sort((a, b) => a.time - b.time);
    return lines;
}

async function musicLyricsLoad(item) {
    musicLyrics.lines = [];
    musicLyrics.activeIndex = -1;
    musicLyricsRender();
    const result = await MusicPlugin.fetchMusicLyric(item);
    // 曲目可能已切走：请求回来时核对还是不是当前曲
    const current = musicPlayerCurrentItem();
    if (!current || musicKey(current) !== musicKey(item)) return;
    musicLyrics.lines = parseLrcText(result && result.rawLrc);
    musicLyricsRender();
}

function musicLyricsRender() {
    const container = musicLyrics.container || document.getElementById('lyricsList');
    if (!container) return;
    musicLyrics.container = container;
    if (!musicLyrics.lines.length) {
        container.innerHTML = '<div class="lyric-empty">暂无歌词</div>';
        return;
    }
    container.innerHTML = musicLyrics.lines.map((line, i) =>
        `<div class="lyric-line" data-lyric-index="${i}">${escapeHtml(line.text || '···')}</div>`
    ).join('');
    musicLyrics.activeIndex = -1;
}

// timeupdate 高频回调：只做高亮切换与滚动
function musicLyricsSync(currentTime) {
    const container = musicLyrics.container || document.getElementById('lyricsList');
    if (!container || !musicLyrics.lines.length) return;
    const lines = musicLyrics.lines;
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].time <= currentTime + 0.2) idx = i; else break;
    }
    if (idx === musicLyrics.activeIndex) return;
    musicLyrics.activeIndex = idx;
    const nodes = container.querySelectorAll('.lyric-line');
    nodes.forEach((node, i) => node.classList.toggle('active', i === idx));
    const active = nodes[idx];
    if (active && typeof active.scrollIntoViewIfNeeded === 'function') {
        active.scrollIntoViewIfNeeded(false);
    } else if (active) {
        container.scrollTop = active.offsetTop - container.clientHeight / 2;
    }
}
