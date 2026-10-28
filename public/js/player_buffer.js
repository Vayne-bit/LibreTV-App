// 播放缓冲策略：拖动后先攒够缓冲再播、卡顿检测与自动降档、播放统计
// 采集站的 m3u8 常见「下载速度 ≈ 码率」：hls.js 的缓冲被抽干就表现为播一秒卡一下，
// 暂停一会儿又能看，是因为暂停期间缓冲重新攒了回来。
// 这里做三件事：拖动后等缓冲、一分钟内卡顿达到阈值就降一档并提示、把现场数据写给诊断信息。

const BUFFER_HOLD_TARGET_SECONDS = 3;
const BUFFER_HOLD_MAX_MS = 15000;
// hls.js 修缓冲空洞时会小幅 nudging（0.1s），那种不算用户拖动，不能触发等待
const BUFFER_HOLD_MIN_JUMP = 10;
const BUFFER_POLL_MS = 250;
// 正常播放时 timeupdate 约 4 次/秒（间隔 250ms）。原来的 1500ms 阈值只能抓到「卡死两秒以上」，
// 而采集站最常见的「播一秒卡一下」每次只停半秒到一秒，全都漏掉了，诊断里因此永远是 0 次。
// 现在两条路都算：waiting 事件（缓冲真的被抽干的直接信号）和间隔超过 800ms。
const BUFFER_STALL_GAP_MS = 800;
// waiting 会紧跟着 timeupdate 的间隔一起出现，同一次卡顿不能记两次
const BUFFER_STALL_COOLDOWN_MS = 1000;
// 拖动后 hls.js 要重新拉分片，这段时间的 waiting / 间隔都不算卡顿
const BUFFER_STALL_SEEK_GUARD_MS = 2000;
const BUFFER_STALL_WINDOW_MS = 60000;
const BUFFER_STALL_SUGGEST_COUNT = 3;
const BUFFER_STALL_MAX_DOWNGRADE = 2;
// 单档片源没法降档，卡到最低档还追不上码率时只能换源。换源会丢掉用户选的线路，
// 所以门槛比提示高得多：一分钟内卡 6 次才动手，两次换源至少隔 3 分钟，一次播放最多换 2 次。
const BUFFER_STALL_SWITCH_COUNT = 6;
const BUFFER_STALL_SWITCH_COOLDOWN_MS = 180000;
const BUFFER_STALL_SWITCH_MAX = 2;
// 降档封顶保持多久：太短会来回抖，太长会让本来能播的清晰度一直上不去
const BUFFER_CAP_RESET_MS = 120000;
// 与 diagnostics.js 里的 DIAGNOSTICS_PLAYER_STATS_KEY 保持一致
const PLAYER_STATS_KEY = 'playerStats';
const PLAYER_STATS_INTERVAL_MS = 10000;

const bufferState = {
    bound: false,
    holding: false,
    token: 0,
    target: 0,
    startedAt: 0,
    timer: null,
    pill: null,
    // 这次暂停是我们为了等缓冲主动做的，pause 事件要吞掉，不能当成用户按了暂停
    selfPaused: false,
    // 开始等缓冲时本来在播放，攒够了才替用户恢复；本来就是暂停就不动
    resumeAfterHold: false,
    capResetTimer: null,
    lastTime: 0,
    lastTickAt: 0,
    lastStallAt: 0,
    seekAt: 0,
    stalls: [],
    downgrades: 0,
    suggested: false,
    switches: 0,
    lastSwitchAt: 0,
    statsTimer: null
};

// time 所在的那一段已缓冲区间还能往后放多少秒
function bufferAheadAt(video, time) {
    if (!video || !video.buffered) return 0;
    const ranges = video.buffered;
    for (let i = 0; i < ranges.length; i++) {
        if (time >= ranges.start(i) - 0.5 && time <= ranges.end(i)) {
            return Math.max(0, ranges.end(i) - time);
        }
    }
    return 0;
}

function bufferAheadNow(video) {
    if (!video) return 0;
    return bufferAheadAt(video, video.currentTime || 0);
}

function ensureBufferPill() {
    if (bufferState.pill && bufferState.pill.isConnected) return bufferState.pill;
    const host = art && art.template && art.template.$player;
    if (!host) return null;
    const pill = document.createElement('div');
    pill.className = 'player-buffer-pill';
    host.appendChild(pill);
    bufferState.pill = pill;
    return pill;
}

function showBufferPill(text) {
    const pill = ensureBufferPill();
    if (!pill) return;
    pill.textContent = text;
    pill.classList.add('show');
}

function hideBufferPill() {
    if (bufferState.pill) bufferState.pill.classList.remove('show');
}

// 拖动后先攒够缓冲再播：hls.js 只保证「有第一片就开播」，
// 网络刚好跟得上码率时，这样开播必然很快又抽干，于是播一秒卡一下。
function startBufferHold(target) {
    const video = art && art.video;
    if (!video) return;
    // 拖动落在已缓冲区间里，本来就能直接放，没必要停下来等
    if (bufferAheadAt(video, target) >= BUFFER_HOLD_TARGET_SECONDS) {
        stopBufferHold(false);
        return;
    }
    if (!bufferState.holding) bufferState.resumeAfterHold = !video.paused;
    bufferState.holding = true;
    bufferState.token += 1;
    bufferState.target = target;
    bufferState.startedAt = Date.now();
    clearTimeout(bufferState.timer);
    if (!video.paused) {
        bufferState.selfPaused = true;
        video.pause();
    }
    showBufferPill(`正在缓冲 0.0s / ${BUFFER_HOLD_TARGET_SECONDS}s`);
    pollBufferHold(bufferState.token);
}

function pollBufferHold(token) {
    if (!bufferState.holding || bufferState.token !== token) return;
    const video = art && art.video;
    if (!video) { stopBufferHold(false); return; }
    const ahead = bufferAheadAt(video, bufferState.target);
    if (ahead >= BUFFER_HOLD_TARGET_SECONDS || Date.now() - bufferState.startedAt >= BUFFER_HOLD_MAX_MS) {
        stopBufferHold(true);
        return;
    }
    showBufferPill(`正在缓冲 ${ahead.toFixed(1)}s / ${BUFFER_HOLD_TARGET_SECONDS}s`);
    bufferState.timer = setTimeout(() => pollBufferHold(token), BUFFER_POLL_MS);
}

function stopBufferHold(resume) {
    const video = art && art.video;
    const shouldResume = resume && bufferState.resumeAfterHold;
    bufferState.holding = false;
    bufferState.token += 1;
    bufferState.resumeAfterHold = false;
    bufferState.selfPaused = false;
    clearTimeout(bufferState.timer);
    bufferState.timer = null;
    hideBufferPill();
    if (!shouldResume || !video || !video.paused) return;
    // 恢复播放前重置卡顿计时，否则「等缓冲期间没 timeupdate」会被算成一次卡顿
    bufferState.lastTickAt = Date.now();
    const played = video.play();
    if (played && typeof played.catch === 'function') played.catch(() => { /* 自动播放被拒时保持暂停 */ });
}

// 实际正在播的档位：loadLevel 是「当前正在加载的档」，ABR 自动模式下比 currentLevel 准
// （currentLevel 在自动模式下恒为 -1，拿它当基准会误以为在最高档）
function currentPlayLevel(hls) {
    if (typeof hls.loadLevel === 'number' && hls.loadLevel >= 0) return hls.loadLevel;
    if (typeof hls.currentLevel === 'number' && hls.currentLevel >= 0) return hls.currentLevel;
    return -1;
}

// 卡顿达到阈值时降一档：ABR 自己判断得太晚，等它反应已经卡了好几秒。
// 降档是临时的，稳定一段时间后放开封顶，让 ABR 自己重新往上试。
function downgradeForStall() {
    const hls = art && art.hls;
    if (!hls || !Array.isArray(hls.levels) || hls.levels.length < 2) return false;
    const playing = currentPlayLevel(hls);
    // 拿不到实际档位时，至少把最高档从 ABR 的可选范围里摘掉
    const base = playing >= 0 ? playing : hls.levels.length - 1;
    const target = Math.max(0, base - 1);
    // 已经在最低档就没有可降的了，别谎报「已降低清晰度」
    if (playing >= 0 && target >= playing) return false;
    if (hls.autoLevelCapping >= 0 && target >= hls.autoLevelCapping) return false;
    hls.autoLevelCapping = target;
    clearTimeout(bufferState.capResetTimer);
    bufferState.capResetTimer = setTimeout(() => {
        bufferState.capResetTimer = null;
        resetAutoLevelCapping();
    }, BUFFER_CAP_RESET_MS);
    return true;
}

// capLevelToPlayerSize 开着时 autoLevelCapping 归 CapLevelController 管，
// 直接置 -1 会让它以为自己已经设过而不再重算，这里主动让它重算一次。
function resetAutoLevelCapping() {
    const hls = art && art.hls;
    if (!hls) return;
    hls.autoLevelCapping = -1;
    const capping = hls.capLevelController;
    if (hls.config && hls.config.capLevelToPlayerSize && capping
        && typeof capping.detectPlayerSize === 'function') {
        capping.detectPlayerSize();
    }
}

// 换源是最后手段：先把能降的档降完，确实卡在最低档还追不上码率才换。
// 单档片源（采集站很常见）没有档可降，只能换，否则用户只能一直看着一秒一卡。
function shouldSwitchForStall() {
    if (typeof autoRelinkAndPlay !== 'function') return false;
    const hls = art && art.hls;
    if (!hls || !Array.isArray(hls.levels) || !hls.levels.length) return false;
    const playing = currentPlayLevel(hls);
    // 还能往下降档就先降档，换源会丢掉用户自己选的线路
    if (hls.levels.length > 1 && playing > 0) return false;
    const bitrate = currentLevelBitrate(hls);
    const estimate = hls.bandwidthEstimate || 0;
    if (!bitrate || !estimate) return false;
    // 带宽只比码率低一点点时降档就够了，差得明显才说明这条线路根本喂不动
    return estimate < bitrate * 1.05;
}

function switchSourceForStall() {
    const now = Date.now();
    if (bufferState.switches >= BUFFER_STALL_SWITCH_MAX) return false;
    if (now - bufferState.lastSwitchAt < BUFFER_STALL_SWITCH_COOLDOWN_MS) return false;
    if (!shouldSwitchForStall()) return false;
    bufferState.lastSwitchAt = now;
    bufferState.switches += 1;
    // 换源后是新的片源，卡顿计数从头算，否则换过去立刻又触发一次
    bufferState.stalls = [];
    bufferState.suggested = false;
    try {
        autoRelinkAndPlay({ reason: 'stall' });
    } catch (e) {
        return false;
    }
    return true;
}

function recordStall() {
    const now = Date.now();
    // waiting 和 timeupdate 间隔往往同一次卡顿各报一次，冷却期内只算一次
    if (now - bufferState.lastStallAt < BUFFER_STALL_COOLDOWN_MS) return;
    bufferState.lastStallAt = now;
    bufferState.stalls.push(now);
    bufferState.stalls = bufferState.stalls.filter(t => now - t <= BUFFER_STALL_WINDOW_MS);
    if (bufferState.stalls.length >= BUFFER_STALL_SUGGEST_COUNT && !bufferState.suggested) {
        bufferState.suggested = true;
        let text = '网络跟不上，建议切换到更低清晰度或换源';
        if (bufferState.downgrades < BUFFER_STALL_MAX_DOWNGRADE && downgradeForStall()) {
            bufferState.downgrades += 1;
            text = '网络跟不上，已自动降低清晰度';
        }
        if (art && art.notice) art.notice.show = text;
    }
    // 提示之后还在继续卡，说明降档也救不回来（或本来就没有档可降），换源
    if (bufferState.stalls.length >= BUFFER_STALL_SWITCH_COUNT) switchSourceForStall();
    writePlayerStats();
}

function currentLevelBitrate(hls) {
    if (!hls || !Array.isArray(hls.levels)) return 0;
    let index = currentPlayLevel(hls);
    if (index < 0) index = hls.autoLevelCapping;
    if (index < 0) return 0;
    const level = hls.levels[index];
    return level ? Math.round(level.bitrate || level.maxBitrate || 0) : 0;
}

function playerEngineLabel() {
    const hlsLib = typeof window !== 'undefined' ? window.Hls : null;
    if (art && art.hls) return `hls.js ${(hlsLib && hlsLib.version) || ''}`.trim();
    if (art && art.flv) return 'flv.js';
    return '原生 video';
}

// 播放页和设置页是两次页面加载，统计只能落 localStorage 给诊断信息读
function writePlayerStats() {
    const video = art && art.video;
    const hls = art && art.hls;
    const config = hls && hls.config ? hls.config : null;
    const payload = {
        at: Date.now(),
        engine: playerEngineLabel(),
        title: currentVideoTitle || '',
        episodeIndex: typeof currentEpisodeIndex === 'number' ? currentEpisodeIndex : 0,
        episodeCount: Array.isArray(currentEpisodes) ? currentEpisodes.length : 0,
        position: video ? Math.round(video.currentTime || 0) : 0,
        duration: video ? Math.round(video.duration || 0) : 0,
        bufferedAhead: video ? Number(bufferAheadNow(video).toFixed(1)) : 0,
        levels: hls && Array.isArray(hls.levels) ? hls.levels.length : 0,
        // 自动模式下 currentLevel 恒为 -1，记实际在播的档位才有诊断价值
        level: hls ? currentPlayLevel(hls) : -1,
        autoLevelCapping: hls ? hls.autoLevelCapping : -1,
        bandwidthEstimate: hls && hls.bandwidthEstimate ? Math.round(hls.bandwidthEstimate) : 0,
        currentBitrate: currentLevelBitrate(hls),
        stalls: bufferState.stalls.length,
        downgrades: bufferState.downgrades,
        switches: bufferState.switches,
        config: config ? {
            maxBufferLength: config.maxBufferLength,
            maxMaxBufferLength: config.maxMaxBufferLength,
            maxBufferHole: config.maxBufferHole,
            maxBufferSize: config.maxBufferSize,
            capLevelToPlayerSize: !!config.capLevelToPlayerSize,
            abrBandWidthUpFactor: config.abrBandWidthUpFactor
        } : null
    };
    try { localStorage.setItem(PLAYER_STATS_KEY, JSON.stringify(payload)); } catch (e) { /* 存储失败不影响播放 */ }
}

// 挂载时机在 art ready 之后，此时 video 元素和 hls 实例都已就绪
function setupPlayerBuffer(instance) {
    if (!instance || bufferState.bound) return;
    bufferState.bound = true;

    instance.on('video:timeupdate', () => {
        const video = instance.video;
        if (!video) return;
        const now = Date.now();
        const gap = bufferState.lastTickAt ? now - bufferState.lastTickAt : 0;
        bufferState.lastTickAt = now;
        bufferState.lastTime = video.currentTime || 0;
        // 后台标签页的 timeupdate 会被浏览器节流，那种间隔不算卡顿
        const visible = (document.visibilityState || 'visible') === 'visible';
        const settled = now - bufferState.seekAt > BUFFER_STALL_SEEK_GUARD_MS;
        if (gap > BUFFER_STALL_GAP_MS && !video.paused && visible && settled) recordStall();
    });

    // 缓冲被抽干时 video 会发 waiting，这是比「间隔」更直接的信号，
    // 「播一秒卡一下」那种短卡顿靠它才抓得到
    instance.on('video:waiting', () => {
        const video = instance.video;
        if (!video || video.paused) return;
        if (bufferState.holding) return;
        if ((document.visibilityState || 'visible') !== 'visible') return;
        if (Date.now() - bufferState.seekAt <= BUFFER_STALL_SEEK_GUARD_MS) return;
        recordStall();
    });

    instance.on('video:play', () => {
        // 用户在我们等缓冲期间自己点了播放，就按用户的意思直接播，不再拦
        if (bufferState.holding) stopBufferHold(false);
        bufferState.lastTickAt = Date.now();
        if (instance.video) bufferState.lastTime = instance.video.currentTime || 0;
    });

    instance.on('video:pause', () => {
        if (bufferState.selfPaused) { bufferState.selfPaused = false; return; }
        // 用户自己按了暂停：等待中的那一次恢复要作废，否则攒够缓冲会替用户播起来
        bufferState.resumeAfterHold = false;
        if (bufferState.holding) stopBufferHold(false);
        writePlayerStats();
    });

    instance.on('video:seeking', () => {
        const video = instance.video;
        if (!video) return;
        // 拖动之后要重新拉分片，期间的 waiting 和空档都不该记成卡顿
        bufferState.seekAt = Date.now();
        bufferState.lastTickAt = bufferState.seekAt;
        // 起播前的那次「恢复到上次位置」也是大跳转，但那时还没开播，
        // 按暂停等缓冲反而会跟自动播放抢，直接跳过
        if (typeof playbackStarted !== 'undefined' && !playbackStarted) return;
        const target = video.currentTime || 0;
        const jump = Math.abs(target - bufferState.lastTime);
        bufferState.lastTime = target;
        if (jump < BUFFER_HOLD_MIN_JUMP) return;
        startBufferHold(target);
    });

    instance.on('video:playing', () => {
        bufferState.lastTickAt = Date.now();
        if (instance.video) bufferState.lastTime = instance.video.currentTime || 0;
    });

    instance.on('video:ended', () => {
        writePlayerStats();
    });

    // 换集说明是新的片源，卡顿计数与降档次数都重新算
    instance.on('video:loadedmetadata', () => {
        bufferState.stalls = [];
        bufferState.downgrades = 0;
        bufferState.suggested = false;
        bufferState.lastTickAt = 0;
        bufferState.lastStallAt = 0;
        bufferState.seekAt = 0;
        writePlayerStats();
    });

    clearInterval(bufferState.statsTimer);
    bufferState.statsTimer = setInterval(writePlayerStats, PLAYER_STATS_INTERVAL_MS);
    writePlayerStats();
}

function teardownPlayerBuffer() {
    clearTimeout(bufferState.timer);
    clearTimeout(bufferState.capResetTimer);
    clearInterval(bufferState.statsTimer);
    bufferState.timer = null;
    bufferState.capResetTimer = null;
    bufferState.statsTimer = null;
    bufferState.holding = false;
    bufferState.selfPaused = false;
    bufferState.resumeAfterHold = false;
    bufferState.bound = false;
    hideBufferPill();
}
