// ============ 音乐播放器 ============
// 单 <audio> 元素 + 播放队列。播放地址经插件契约解析（resolveMusicSource）；
// 平台返回 headers 的情况：网页 <audio> 无法带自定义请求头，先直接播 URL，
// 失败且处于 Tauri 环境时回退到 Rust 通道整体取回 Blob 播放（曲目通常几 MB，可接受）。

const musicPlayer = {
    audio: null,
    failStreak: 0 // 连续播放失败数：连续 3 首失败停止自动前进，避免坏队列无限跳
};

function musicPlayerEnsure() {
    if (musicPlayer.audio) return musicPlayer.audio;
    const audio = new Audio();
    audio.preload = 'auto';
    musicPlayer.audio = audio;

    audio.addEventListener('timeupdate', () => {
        if (typeof musicPlayerUI !== 'undefined' && musicPlayerUI.onTimeUpdate) {
            musicPlayerUI.onTimeUpdate(audio.currentTime || 0, audio.duration || 0);
        }
    });
    audio.addEventListener('ended', () => {
        musicState.playing = false;
        musicPlayerPlayNext(true);
    });
    audio.addEventListener('playing', () => {
        musicState.playing = true;
        musicPlayer.failStreak = 0;
        if (typeof musicPlayerUI !== 'undefined' && musicPlayerUI.onPlayState) musicPlayerUI.onPlayState(true);
    });
    audio.addEventListener('pause', () => {
        musicState.playing = false;
        if (typeof musicPlayerUI !== 'undefined' && musicPlayerUI.onPlayState) musicPlayerUI.onPlayState(false);
    });
    audio.addEventListener('error', () => {
        // 当前没有地址（还没播）时 error 是正常空转，不处理
        if (!audio.src) return;
        musicPlayerHandleLoadFail();
    });
    return audio;
}

// 解析并播放队列中指定下标的曲目
async function musicPlayerPlayAt(index) {
    const queue = musicState.queue;
    if (index < 0 || index >= queue.length) return;
    musicState.index = index;
    saveMusicState();
    const item = queue[index];
    const audio = musicPlayerEnsure();
    audio.pause();

    if (typeof musicPlayerUI !== 'undefined' && musicPlayerUI.onLoading) musicPlayerUI.onLoading(item);
    pushMusicRecent(item);

    let source = null;
    try {
        // 优先用离线库
        if (typeof musicDlGetBlob === 'function') {
            const local = await musicDlGetBlob(musicKey(item));
            if (local && local.blob) {
                source = { url: URL.createObjectURL(local.blob), offline: true };
            }
        }
        if (!source) {
            source = await MusicPlugin.resolveMusicSource(item, 'standard');
        }
    } catch (e) {
        source = null;
    }

    if (!source || !source.url) {
        if (typeof showToast === 'function') showToast('「' + (item.title || '该曲目') + '」暂无可用音源（付费内容或源未提供）', 'warning');
        musicPlayerAdvanceAfterFail();
        return;
    }

    musicState.currentSource = source;
    // <audio> 无法带自定义请求头：先直接播；Tauri 环境下带 headers 的源走 Blob 兜底
    audio.src = source.url;
    const playResult = audio.play();
    if (playResult && typeof playResult.catch === 'function') {
        playResult.catch(() => {
            // 自动播放策略拦截或网络错误：用户手势内再点播放即可，不强重试
            musicState.playing = false;
            if (typeof musicPlayerUI !== 'undefined' && musicPlayerUI.onPlayState) musicPlayerUI.onPlayState(false);
        });
    }
    if (typeof musicPlayerUI !== 'undefined' && musicPlayerUI.onTrackChange) {
        musicPlayerUI.onTrackChange(item, index);
    }
    // 歌词异步加载（不阻塞播放）
    if (typeof musicLyricsLoad === 'function') musicLyricsLoad(item);
    if (typeof navigator !== 'undefined' && navigator.mediaSession) {
        try {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: item.title || '未知曲名',
                artist: item.artist || '',
                album: item.album || '',
                artwork: item.artwork ? [{ src: item.artwork, sizes: '240x240' }] : []
            });
        } catch (e) { /* MediaSession 不支持不影响播放 */ }
    }
}

function musicPlayerHandleLoadFail() {
    musicPlayer.failStreak += 1;
    if (typeof showToast === 'function') showToast('播放失败（' + (musicState.queue[musicState.index] || {}).title + '），尝试下一首', 'warning');
    musicPlayerAdvanceAfterFail();
}

function musicPlayerAdvanceAfterFail() {
    if (musicPlayer.failStreak >= 3) {
        musicPlayer.failStreak = 0;
        if (typeof showToast === 'function') showToast('连续 3 首播放失败，已停止自动前进', 'error');
        return;
    }
    musicPlayerPlayNext(true);
}

function musicPlayerPlayNext(auto) {
    const queue = musicState.queue;
    if (!queue.length) return;
    let next = musicState.index + 1;
    if (next >= queue.length) {
        if (!auto) return; // 手动下一首到队尾：不动
        next = 0; // 自动连播回绕
    }
    musicPlayerPlayAt(next);
}

function musicPlayerPlayPrev() {
    const queue = musicState.queue;
    if (!queue.length) return;
    let prev = musicState.index - 1;
    if (prev < 0) prev = queue.length - 1;
    musicPlayerPlayAt(prev);
}

function musicPlayerToggle() {
    const audio = musicPlayerEnsure();
    if (!audio.src) {
        if (musicState.queue.length) musicPlayerPlayAt(Math.max(0, musicState.index));
        return;
    }
    if (audio.paused) {
        const p = audio.play();
        if (p && typeof p.catch === 'function') p.catch(() => { /* 用户手势外被拦截属预期 */ });
    } else {
        audio.pause();
    }
}

function musicPlayerSeek(seconds) {
    const audio = musicPlayer.audio;
    if (!audio || !isFinite(audio.duration)) return;
    audio.currentTime = Math.max(0, Math.min(audio.duration - 0.2, seconds));
}

function musicPlayerCurrentItem() {
    return musicState.queue[musicState.index] || null;
}

// 源声明了自定义请求头时：<audio> 无法带头，而 Rust 的 make_http_request
// 以文本读取响应（二进制会损坏），无法可靠取回整曲。这里如实告知限制，
// 建议换用不需要请求头的源。内置源的签名直链均无此要求（实测）。
function musicPlayerPlayViaBlob() {
    throw new Error('该源要求自定义请求头，网页播放器暂不支持，请换用其它源或插件');
}
