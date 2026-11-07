// ============ 音乐源插件系统 ============
// 采用 MusicFree 兼容契约（https://musicfree.catcat.work/plugin/protocol.html）：
// 插件是导出特定函数集的 CommonJS 模块，核心函数：
//   search(query, page, type)  -> { isEnd, data: [musicItem] }
//   getMediaSource(musicItem, quality) -> { url, headers?, userAgent? } | null
//   getLyric(musicItem)        -> { rawLrc, translation? } | null
//   getTopLists() / getTopListDetail(sheet)   （可选：排行榜）
// musicItem 约定字段：{ id, title, artist, album?, artwork?, duration?, platform? }
//
// 信任边界（与 MusicFree 相同，需向用户明示）：插件代码在页面同一 JS 上下文
// 中执行，理论上可以做任何事——只导入可信来源的插件。
//
// 内置源（酷狗·公开接口）以同一契约实现，作为开箱即用的演示源：
// 实测链路（2026-11-05）：
//   搜索  songsearch.kugou.com/song_search_v2           -> 200 JSON（hash/品质/歌手/封面）
//   播放  m.kugou.com/app/i/getSongInfo.php?cmd=playInfo -> sharefs 签名直链（206 audio/mpeg，
//                                                          无 UA/Referer 要求，<audio> 可直接播）
//   歌词  krcs.kugou.com/search + /download              -> base64 LRC
// 平台不给播放地址的内容（如部分 VIP 曲目）如实返回 null 并提示，
// 不做任何解锁/绕过。
(function (global) {
    'use strict';

    const MUSIC_PLUGIN_KEY = 'musicPlugins';       // 已导入的第三方插件源码数组
    const MUSIC_SOURCE_SWITCH_KEY = 'musicSourceDisabled'; // { [platform]: true } 禁用表

    const musicSourceRegistry = [];                // [{ platform, version, source, builtin }]
    let builtinRegistered = false;

    // ---------- 工具 ----------

    function musicSourceDisabledMap() {
        try {
            const parsed = JSON.parse(localStorage.getItem(MUSIC_SOURCE_SWITCH_KEY) || '{}');
            return parsed && typeof parsed === 'object' ? parsed : {};
        } catch (e) {
            return {};
        }
    }

    function isSourceDisabled(platform) {
        return !!musicSourceDisabledMap()[platform];
    }

    function setSourceDisabled(platform, disabled) {
        try {
            const map = musicSourceDisabledMap();
            if (disabled) map[platform] = true; else delete map[platform];
            localStorage.setItem(MUSIC_SOURCE_SWITCH_KEY, JSON.stringify(map));
        } catch (e) { /* 存储满不影响功能 */ }
    }

    function stripTags(text) {
        return String(text || '').replace(/<[^>]+>/g, '').trim();
    }

    // ---------- 内置源：酷狗·公开接口 ----------
    // 与插件同契约。只聚合平台对公众正常下发的内容；付费内容若无地址则如实提示。

    const kugouSource = {
        platform: '酷狗',
        version: '1.0.0',
        builtin: true,
        description: '酷狗公开接口（搜索/播放/歌词）。付费内容若无公开音源会提示不可播。',
        _UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        _UA_MOBILE: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',

        async _get(url, mobile) {
            const useTauri = typeof isTauriApp === 'function' && isTauriApp() && typeof tauriInvoke === 'function';
            if (useTauri) {
                // App 内走 Rust 通道：绕过 WebView 的 CORS/混合内容限制，且带桌面 UA
                const resp = await tauriInvoke('make_http_request', {
                    options: {
                        url, method: 'GET',
                        headers: { 'User-Agent': mobile ? this._UA_MOBILE : this._UA },
                        timeout_secs: 12, response_as_text: true
                    }
                });
                if (!(resp.status >= 200 && resp.status < 300)) throw new Error('HTTP ' + resp.status);
                return resp.body;
            }
            const resp = await fetch(url, { headers: { 'User-Agent': mobile ? this._UA_MOBILE : this._UA } });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return resp.text();
        },

        async search(query, page, type) {
            if (type !== 'music') return { isEnd: true, data: [] };
            const text = await this._get('https://songsearch.kugou.com/song_search_v2?keyword='
                + encodeURIComponent(query) + '&page=' + (page || 1) + '&pagesize=30');
            const json = JSON.parse(text);
            const lists = (json.data && json.data.lists) || [];
            const data = lists.map(item => ({
                id: String(item.AlbumAudioID || item.MixSongID || item.Audioid || item.FileHash),
                hash: item.FileHash || '',
                hqHash: item.HQFileHash || '',
                albumId: String(item.AlbumID || ''),
                title: stripTags(item.SongName || item.OriSongName || '未知曲名'),
                artist: stripTags(item.SingerName || (item.Singers || []).map(s => s.name).join('/') || '未知歌手'),
                album: stripTags(item.AlbumName || ''),
                artwork: (item.Image || item.AlbumImage || '').replace('{size}', '240'),
                duration: Number(item.Duration) || 0,
                payHint: !!item.PayType
            }));
            const total = (json.data && json.data.total) || 0;
            return { isEnd: (page || 1) * 30 >= total, data };
        },

        async getMediaSource(musicItem, quality) {
            // 品质映射：standard=128k（FileHash），high=320k（HQFileHash，若该曲目有）
            const hash = (quality === 'high' || quality === 'super') && musicItem.hqHash
                ? musicItem.hqHash : (musicItem.hash || musicItem.id);
            if (!hash) return null;
            const text = await this._get('https://m.kugou.com/app/i/getSongInfo.php?cmd=playInfo&hash='
                + encodeURIComponent(hash), true);
            const json = JSON.parse(text);
            const url = json.url || (Array.isArray(json.backup_url) && json.backup_url[0]) || '';
            if (!url) return null; // 平台未公开下发播放地址（常见于付费内容）——如实返回
            return {
                url,
                headers: json.url ? { 'User-Agent': this._UA_MOBILE } : undefined,
                // 直接播放成功率实测极高；字段仅作参考
                size: Number(json.fileSize) || 0,
                bitrate: Number(json.bitRate) || 0
            };
        },

        async getLyric(musicItem) {
            const hash = musicItem.hash || '';
            const keyword = encodeURIComponent((musicItem.title || '') + ' ' + (musicItem.artist || ''));
            const searchText = await this._get('https://krcs.kugou.com/search?ver=1&man=yes&client=mobi&keyword='
                + keyword + '&duration=&hash=' + encodeURIComponent(hash), true);
            const found = JSON.parse(searchText);
            const candidate = (found.candidates || [])[0];
            if (!candidate) return null;
            const dlText = await this._get('https://krcs.kugou.com/download?ver=1&client=mobi&id='
                + candidate.id + '&accesskey=' + encodeURIComponent(candidate.accesskey)
                + '&fmt=lrc&charset=utf8', true);
            const dl = JSON.parse(dlText);
            if (!dl.content) return null;
            // 内容是 base64 的 LRC 文本
            const rawLrc = decodeURIComponent(escape(atob(dl.content)));
            return { rawLrc };
        }
    };

    // ---------- 咪咕源（借鉴 go-music-dl/music-lib 的公开端点，2026-11-07 实测）----------
    // 搜索 pd.musicapp.migu.cn search_all.do（全球可用，实测 200/20 条）；
    // 播放 c.musicapp.migu.cn listen-url（App 头 GET，按 toneFlag 取 PQ/HQ/SQ）。
    // 免费内容给完整曲（4.3MB/128k 实测大小合理）；版权方限制或海外 IP 会返回
    // cannotCode 440001「暂无法在当前地区提供服务」——如实报错。
    // 免登录可用；登录 Cookie 提升音质（本项目不引入登录）。
    const miguSource = {
        platform: '咪咕',
        version: '1.0.0',
        builtin: true,
        description: '咪咕音乐公开接口（搜索/播放/歌词）。免费内容给完整曲；部分版权内容有地区限制。',
        _UA_APP: 'Android_migu/7.41.13 okhttp/3.12.13',

        async _get(url, headers) {
            const useTauri = typeof isTauriApp === 'function' && isTauriApp() && typeof tauriInvoke === 'function';
            const h = Object.assign({ 'User-Agent': this._UA_APP }, headers || {});
            if (useTauri) {
                // App 内走 Rust 通道（咪咕接口无 CORS 头，WebView 直连会被拦）
                const resp = await tauriInvoke('make_http_request', {
                    options: { url, method: 'GET', headers: h, timeout_secs: 12, response_as_text: true }
                });
                if (!(resp.status >= 200 && resp.status < 300)) throw new Error('HTTP ' + resp.status);
                return resp.body;
            }
            const resp = await fetch(url, { headers: h });
            if (!resp.ok) throw new Error('HTTP ' + resp.status);
            return resp.text();
        },

        async search(query, page, type) {
            if (type !== 'music') return { isEnd: true, data: [] };
            const sw = encodeURIComponent('{"song":1,"album":0,"singer":0,"tagSong":0,"mvSong":0,"songlist":0,"bestShow":1}');
            const text = await this._get('http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?ua=Android_migu&version=5.0.1&text='
                + encodeURIComponent(query) + '&pageNo=' + (page || 1) + '&pageSize=20&searchSwitch=' + sw,
                { Referer: 'http://m.music.migu.cn/' });
            const json = JSON.parse(text);
            const list = (json.songResultData && json.songResultData.result) || [];
            const data = list.map(item => {
                const toneOf = t => (item.newRateFormats || []).find(f => f.formatType === t);
                const artwork = ((item.imgItems || [])[0] || {}).img || '';
                return {
                    id: String(item.contentId || item.copyrightId || ''),
                    contentId: String(item.contentId || ''),
                    copyrightId: String(item.copyrightId || ''),
                    songId: String(item.songId || ''),
                    resourceType: String(item.resourceType || '2'),
                    lyricUrl: item.lyricUrl || '',
                    hasHQ: !!toneOf('HQ'),
                    hasSQ: !!toneOf('SQ'),
                    title: stripTags(item.songName || item.name || '未知曲名'),
                    artist: stripTags((item.singers || []).map(s => s.name).join('/')
                        || String(item.singerName || '').replace(/<[^>]+>/g, '') || '未知歌手'),
                    album: stripTags(((item.albums || [])[0] || {}).name || ''),
                    artwork: artwork.startsWith('http') ? artwork : (artwork ? 'https://d.musicapp.migu.cn/' + artwork.replace(/^\//, '') : ''),
                    duration: Number(item.duration) || 0,
                    payHint: false
                };
            });
            const total = (json.songResultData && json.songResultData.totalCount) || data.length;
            return { isEnd: (page || 1) * 20 >= total, data };
        },

        async getMediaSource(musicItem, quality) {
            // 音质映射：standard=PQ(128k)，high=HQ(320k)，super=SQ(flac)；
            // 目标档拿不到自动落到 PQ（与 music-lib 的 [ZQ32, target, PQ] 阶梯同思路的简化版）
            const tones = quality === 'super' ? ['SQ', 'HQ', 'PQ']
                : quality === 'high' ? (musicItem.hasHQ ? ['HQ', 'PQ'] : ['PQ'])
                : ['PQ'];
            for (const tone of tones) {
                const p = new URLSearchParams({
                    netType: '01',
                    resourceType: musicItem.resourceType || '2',
                    contentId: musicItem.contentId || musicItem.id || '',
                    toneFlag: tone
                });
                if (musicItem.copyrightId) p.set('copyrightId', musicItem.copyrightId);
                if (musicItem.songId) p.set('songId', musicItem.songId);
                const text = await this._get('https://c.musicapp.migu.cn/MIGUM2.0/v2.1/content/listen-url?' + p.toString(), {
                    channel: '0146832', version: '7.41.13', Referer: 'https://music.migu.cn/'
                });
                const json = JSON.parse(text);
                const d = json.data || {};
                if (d.url) {
                    const url = d.url.startsWith('//') ? 'https:' + d.url : d.url;
                    return { url, headers: null };
                }
                // 地区限制/版权限制：如实抛出（不再往低档试——地区错误换档也一样）
                if (d.cannotCode === '440001' || (d.dialogInfo && d.dialogInfo.text)) {
                    throw new Error((d.dialogInfo && d.dialogInfo.text) || '该内容在当前地区不可用');
                }
            }
            return null; // 各档都无 URL：交给上层「暂无可用音源」提示/换源
        },

        async getLyric(musicItem) {
            if (!musicItem.lyricUrl) return null;
            const text = await this._get(musicItem.lyricUrl.startsWith('//') ? 'https:' + musicItem.lyricUrl : musicItem.lyricUrl);
            if (!text || text.length < 4) return null;
            return { rawLrc: text };
        }
    };

    // ---------- 插件加载与导入 ----------

    function registerSource(source, builtin) {
        if (!source || !source.platform) return false;
        const exist = musicSourceRegistry.find(item => item.platform === source.platform);
        if (exist) {
            exist.source = source;
            exist.version = source.version || exist.version;
            exist.builtin = !!builtin;
            return true;
        }
        musicSourceRegistry.push({ platform: source.platform, version: String(source.version || ''), source, builtin: !!builtin });
        return true;
    }

    // 加载内置源（幂等，页面加载时调用一次）
    function initBuiltinMusicSources() {
        if (builtinRegistered) return;
        registerSource(kugouSource, true);
        registerSource(miguSource, true);
        builtinRegistered = true;
    }

    // 把 CommonJS 插件源码实例化。MusicFree 插件即此形态（module.exports = {...}）。
    function instantiatePluginCode(code, originLabel) {
        if (typeof code !== 'string' || code.length < 8) throw new Error('插件内容为空');
        if (code.length > 1024 * 1024) throw new Error('插件超过 1MB，拒绝加载');
        // 极性防御：显式拒绝常见危险形态（同上下文执行的代价是必须做基本检查）
        if (/\bwhile\s*\(\s*true\s*\)/.test(code)) throw new Error('插件包含死循环，拒绝加载');
        // 导入静态扫描（纵深防御第二层；第一层是 new Function 的形参遮蔽）。
        // 硬拒绝：触达宿主能力/自我持久化——音源插件没有任何正当理由用它们：
        //   tauriInvoke/__TAURI_* = 调宿主命令；indexedDB/importScripts = 越权存储/加载；
        //   MusicPlugin = 试图反向注册自己（持久化任意后续代码）；document.cookie = 窃取会话。
        // 注意不拦 fetch/XHR/axios——音源插件联网查歌是正当能力。
        // （不是完整沙箱，彻底隔离需 Worker 重构——在案。）
        if (/\b(tauriInvoke|__TAURI_INTERNALS__|__TAURI__|MusicPlugin|indexedDB|importScripts)\b/.test(code)
            || /document\s*\.\s*cookie/.test(code)) {
            throw new Error('插件包含宿主能力调用（tauriInvoke/存储/反向注册），已拒绝加载');
        }
        const moduleObj = { exports: {} };
        try {
            const factory = new Function('module', 'exports', 'window', 'document', 'globalThis',
                '"use strict";\n' + code + '\nreturn module.exports;');
            const exported = factory(moduleObj, moduleObj.exports, undefined, undefined, undefined);
            const source = exported && Object.keys(exported).length ? exported : moduleObj.exports;
            if (!source || !source.platform) throw new Error('插件未导出 platform 字段');
            if (typeof source.search !== 'function' && typeof source.getMediaSource !== 'function') {
                throw new Error('插件至少需要实现 search 或 getMediaSource');
            }
            return source;
        } catch (e) {
            throw new Error('插件加载失败（' + (originLabel || '未知来源') + '）：' + (e && e.message || e));
        }
    }

    function readStoredPluginCodes() {
        try {
            const parsed = JSON.parse(localStorage.getItem(MUSIC_PLUGIN_KEY) || '[]');
            return Array.isArray(parsed) ? parsed.filter(c => typeof c === 'string') : [];
        } catch (e) {
            return [];
        }
    }

    function writeStoredPluginCodes(codes) {
        localStorage.setItem(MUSIC_PLUGIN_KEY, JSON.stringify(codes.filter(c => typeof c === 'string')));
    }

    // 从源码文本导入插件（粘贴或文件内容）。同名（platform）覆盖旧版。
    function importMusicPlugin(code) {
        const source = instantiatePluginCode(code, '导入内容');
        const codes = readStoredPluginCodes();
        // 同名替换：先加载旧码找到同名索引
        let replaced = false;
        for (let i = 0; i < codes.length; i++) {
            try {
                if (instantiatePluginCode(codes[i], '已存插件').platform === source.platform) {
                    codes[i] = code; replaced = true; break;
                }
            } catch (e) { /* 旧码坏了，跳过 */ }
        }
        if (!replaced) codes.push(code);
        writeStoredPluginCodes(codes);
        registerSource(source, false);
        return { platform: source.platform, version: source.version || '', replaced };
    }

    function removeMusicPlugin(platform) {
        const codes = readStoredPluginCodes();
        const kept = codes.filter(code => {
            try { return instantiatePluginCode(code, '已存插件').platform !== platform; }
            catch (e) { return true; } // 无法实例化的保留原样（用户可看到加载报错）
        });
        writeStoredPluginCodes(kept);
        const idx = musicSourceRegistry.findIndex(item => item.platform === platform && !item.builtin);
        if (idx >= 0) musicSourceRegistry.splice(idx, 1);
    }

    // 启动时载入已存插件（坏插件逐个隔离，不拖垮其它源）
    function loadStoredMusicPlugins() {
        initBuiltinMusicSources();
        readStoredPluginCodes().forEach(code => {
            try {
                registerSource(instantiatePluginCode(code, '已存插件'), false);
            } catch (e) {
                console.warn('[music] 插件加载失败：', e && e.message);
            }
        });
    }

    function listMusicSources() {
        initBuiltinMusicSources();
        return musicSourceRegistry.map(item => ({
            platform: item.platform,
            version: item.version,
            builtin: item.builtin,
            disabled: isSourceDisabled(item.platform),
            hasSearch: typeof item.source.search === 'function',
            description: item.source.description || ''
        }));
    }

    function getEnabledMusicSources() {
        initBuiltinMusicSources();
        return musicSourceRegistry
            .filter(item => !isSourceDisabled(item.platform))
            .map(item => item.source);
    }

    function getMusicSourceByPlatform(platform) {
        initBuiltinMusicSources();
        const hit = musicSourceRegistry.find(item => item.platform === platform);
        return hit ? hit.source : null;
    }

    // 统一的播放地址解析：内置源与插件走同一入口
    async function resolveMusicSource(musicItem, quality) {
        const source = getMusicSourceByPlatform(musicItem.platform);
        if (!source) throw new Error('未找到音源「' + (musicItem.platform || '?') + '」');
        if (typeof source.getMediaSource !== 'function') throw new Error('该源不支持解析播放地址');
        const result = await source.getMediaSource(musicItem, quality || 'standard');
        if (!result || !result.url) return null; // 源明确表示无可用地址（如付费内容）
        return result;
    }

    async function fetchMusicLyric(musicItem) {
        const source = getMusicSourceByPlatform(musicItem.platform);
        if (!source || typeof source.getLyric !== 'function') return null;
        try { return await source.getLyric(musicItem); } catch (e) { return null; }
    }

    // ---------- 对外 ----------
    global.MusicPlugin = {
        initBuiltinMusicSources,
        loadStoredMusicPlugins,
        importMusicPlugin,
        removeMusicPlugin,
        listMusicSources,
        getEnabledMusicSources,
        getMusicSourceByPlatform,
        setSourceDisabled,
        resolveMusicSource,
        fetchMusicLyric,
        MUSIC_PLUGIN_KEY
    };
})(window);
