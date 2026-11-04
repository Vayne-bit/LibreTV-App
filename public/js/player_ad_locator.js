// ============ 广告块自动定边界 ============
// 背景：插入式广告（SSAI）在播放列表里是一整块独立分片，特征是
//   #EXT-X-DISCONTINUITY + #EXT-X-KEY:METHOD=NONE + 独立的路径前缀 + 时长规整。
// 用户长按一次（而不是标记起点+终点两次），程序沿这些特征把整块广告自动框出来。
//
// 为什么要自动：用户看到的是连续画面，不知道分片边界在哪。
// 让他手动框起止不仅麻烦，而且框不准 —— 分片边界和画面里的广告边界本来就不重合。
// 交给程序按结构特征框，用户只需要确认「对，就是这一段」。
//
// 安全阀（任一不满足就放弃自动识别，退回手动标记）：
//   1. 候选块必须同时具备：断点标记、无加密 KEY、独立路径前缀、时长规整
//   2. 该块的路径前缀在整集正片里都不能出现（不能把正片目录当成广告）
//   3. 块时长 ≤ AD_BLOCK_MAX_SECONDS 且分片数 ≤ MAX_BLOCK_SEGMENTS
//   4. 整集里不能有多个候选块指向同一前缀（避免把「正片分片目录」误当广告）
(function (global) {
    'use strict';

    const AD_BLOCK_MAX_SECONDS = 300;
    const MAX_BLOCK_SEGMENTS = 40;
    // 分片时长规整度：块内所有分片时长都相同 → 强特征；差异在 15% 内 → 弱特征
    const UNIFORM_TOLERANCE = 0.15;

    // 块内分片时长是否规整
    // 注意：广告块末尾常有一段「残片」（时长明显偏短，用来对齐回正片时间轴），
    // 所以不能要求所有分片时长都一样 —— 用众数（最常见的时长）来判断，
    // 只要「时长等于众数的分片」占多数，就算规整。
    function isUniformDuration(segments) {
        if (!segments.length) return false;
        // 统计各时长（保留一位小数，避开浮点误差）出现次数
        const counts = new Map();
        segments.forEach(s => {
            const key = Math.round(s.duration * 10) / 10;
            counts.set(key, (counts.get(key) || 0) + 1);
        });
        let mode = 0;
        let modeCount = 0;
        counts.forEach((n, d) => {
            if (n > modeCount) { modeCount = n; mode = d; }
        });
        if (!mode) return false;
        // 众数时长占块内分片数的一半以上 → 规整
        // 允许一个残片：末片时长明显短于众数时不算破坏规整
        let matching = 0;
        let outliers = 0;
        segments.forEach(s => {
            const d = Math.round(s.duration * 10) / 10;
            if (Math.abs(d - mode) <= mode * UNIFORM_TOLERANCE) matching += 1;
            else if (s.duration < mode * 0.7) outliers += 1; // 偏短的残片
        });
        if (matching + outliers < segments.length) return false;
        return matching >= Math.max(1, Math.ceil(segments.length / 2));
    }

    // 块内分片是否全部来自同一路径前缀
    function singlePrefix(segments) {
        const set = new Set(segments.map(s => s.pathPrefix));
        return set.size === 1 ? set.values().next().value : '';
    }

    // 找出所有「疑似广告块」：结构特征齐备且路径前缀没在正片出现过
    function findAdBlockCandidates(playlist) {
        if (!playlist || !playlist.blocks) return [];
        const candidates = [];

        playlist.blocks.forEach((block, index) => {
            if (!block.segments.length) return;
            // 特征 1：必须有断点标记（没有断点的一律不动，这是安全底线）
            if (!block.discontinuity) return;
            // 特征 2：无加密 KEY —— 正片通常全程加密，广告块会切到 METHOD=NONE
            if (!block.keyNone) return;
            // 特征 3：块内分片来自同一路径前缀
            const prefix = singlePrefix(block.segments);
            if (!prefix) return;
            // 特征 4：时长规整（广告分片常是固定 5s/10s，正片时长不规则）
            if (!isUniformDuration(block.segments)) return;
            // 安全阀：时长与分片数
            if (block.duration <= 0 || block.duration > AD_BLOCK_MAX_SECONDS) return;
            if (block.segments.length > MAX_BLOCK_SEGMENTS) return;
            // 安全阀：这个前缀占全片时长不能超过 30%（正片主体目录一定远超这个比例）
            let prefixDuration = 0;
            let totalDuration = 0;
            playlist.blocks.forEach(b => {
                b.segments.forEach(s => {
                    totalDuration += s.duration;
                    if (s.pathPrefix === prefix) prefixDuration += s.duration;
                });
            });
            if (totalDuration > 0 && prefixDuration / totalDuration > 0.3) return;
            // 安全阀：同一前缀可以出现在多个块里（广告常在片头片尾各插一次），
            // 但这些块必须是同一组分片的复用 —— 分片集合完全相同。
            // 若分片集合不同，说明这是正片的普通分块，不能当广告。
            const samePrefixBlocks = playlist.blocks.filter(b =>
                b.segments.length && b.segments.every(s => s.pathPrefix === prefix));
            if (samePrefixBlocks.length > 1) {
                const sig = s => s.segments.map(x => x.uri).sort().join('|');
                const first = sig(samePrefixBlocks[0]);
                if (!samePrefixBlocks.every(b => sig(b) === first)) return;
            }

            candidates.push({
                blockIndex: index,
                prefix: prefix,
                start: block.segments[0].start,
                end: block.segments[block.segments.length - 1].end,
                duration: block.duration,
                segmentCount: block.segments.length,
                segmentUris: block.segments.map(s => s.uri)
            });
        });
        return candidates;
    }

    // 用户当前播放位置命中的候选块
    // currentTime 是播放时间轴上的位置；候选块的 start/end 也是同一时间轴（EXTINF 累加），
    // 两者可直接比较。命中多个时取时长最短的那个（广告块比正片段更短）。
    function candidateAt(playlist, currentTime, candidates) {
        if (!playlist) return null;
        const list = candidates || findAdBlockCandidates(playlist);
        const hits = list.filter(c => currentTime >= c.start && currentTime < c.end);
        if (!hits.length) return null;
        hits.sort((a, b) => a.duration - b.duration);
        return hits[0];
    }

    // 把原始清单时间轴上的时刻，换算成播放时间轴上的时刻。
    //
    // 为什么要换算：自动过滤删掉了一些广告分片，播放器拿到的是删过的清单，
    // 后面所有分片的时间起点都前移了。art.currentTime 是播放时间轴，
    // 而候选块的 start/end 来自原始清单（过滤前），两者差一个累计偏移。
    //
    // 算法：两个时间轴的差值 = 目标时刻之前「已被删除的分片」的时长总和。
    // 被删的分片在播放时间轴上不存在，那一段时长整体消失，后面的分片全部前移。
    //
    // removedIds 用「URI + 出现序号」标识（同一个广告文件名可能在片头片尾各出现一次，
    // 只看 URI 会分不清是哪一个）。区间两端用同一套偏移 → 长度守恒。
    function toPlaybackTime(playlist, originalTime, removedIds) {
        if (!playlist || !removedIds || !removedIds.size) return originalTime;
        let removedBefore = 0;
        for (let i = 0; i < playlist.segments.length; i++) {
            const seg = playlist.segments[i];
            if (seg.start >= originalTime) break;
            if (removedIds.has(seg.id)) removedBefore += seg.duration;
        }
        return originalTime - removedBefore;
    }

    global.AdBlockLocator = {
        findAdBlockCandidates: findAdBlockCandidates,
        candidateAt: candidateAt,
        toPlaybackTime: toPlaybackTime,
        isUniformDuration: isUniformDuration,
        singlePrefix: singlePrefix
    };
})(window);
