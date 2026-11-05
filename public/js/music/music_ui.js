// ============ 音乐页 UI ============
// 结构：搜索标签 + 结果列表 / 队列 / 收藏 / 下载 / 插件管理 五个视图，
// 底部常驻播放条 + 歌词面板。事件全部走委托（与项目其它页一致）。

const musicUIState = { view: 'search', searchTokenSeen: -1 };

const musicPlayerUI = {
    onLoading(item) { musicUIRenderPlayerBar(); musicUIRenderQueue(); },
    onTrackChange(item, index) { musicUIRenderPlayerBar(); musicUIRenderQueue(); },
    onPlayState(playing) { musicUIRenderPlayerBar(); },
    onTimeUpdate(current, duration) {
        musicLyricsSync(current);
        const bar = document.getElementById('musicProgress');
        const cur = document.getElementById('musicProgressCur');
        const dur = document.getElementById('musicProgressDur');
        if (bar && duration > 0) bar.value = String(Math.round(current));
        if (cur) cur.textContent = formatMusicDuration(current);
        if (dur) dur.textContent = formatMusicDuration(duration);
    }
};

// ---------- 播放条 ----------

function musicUIRenderPlayerBar() {
    const item = musicPlayerCurrentItem();
    const cover = document.getElementById('barCover');
    const title = document.getElementById('barTitle');
    const artist = document.getElementById('barArtist');
    const playBtn = document.getElementById('barPlayBtn');
    if (!title) return;
    if (!item) {
        title.textContent = '未在播放';
        artist.textContent = '';
        if (cover) cover.textContent = '♪';
        if (playBtn) playBtn.innerHTML = musicIconPlay();
        return;
    }
    title.textContent = item.title || '未知曲名';
    artist.textContent = [item.artist, item.platform].filter(Boolean).join(' · ');
    if (cover) {
        cover.textContent = '';
        cover.style.backgroundImage = item.artwork ? `url("${item.artwork}")` : '';
        cover.classList.toggle('no-art', !item.artwork);
    }
    if (playBtn) playBtn.innerHTML = musicState.playing ? musicIconPause() : musicIconPlay();
}

function musicIconPlay() {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M8 5.5v13l11-6.5z"/></svg>';
}
function musicIconPause() {
    return '<svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
}
function musicIconDownload() {
    return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7.5 10.5L12 15l4.5-4.5"/><path d="M5 19h14"/></svg>';
}

// ---------- 视图切换 ----------

function musicUISetView(view) {
    musicUIState.view = view;
    document.querySelectorAll('[data-music-tab]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.musicTab === view);
    });
    ['search', 'queue', 'favorites', 'downloads', 'plugins'].forEach(name => {
        const el = document.getElementById('musicView-' + name);
        if (el) el.classList.toggle('hidden', name !== view);
    });
    if (view === 'queue') musicUIRenderQueue();
    if (view === 'favorites') musicUIRenderFavorites();
    if (view === 'downloads') musicUIRenderDownloads();
    if (view === 'plugins') musicUIRenderPlugins();
    if (view === 'search') musicUIRenderSearch();
}

// ---------- 搜索视图 ----------

function musicUIRenderSearch() {
    const box = document.getElementById('searchResults');
    if (!box) return;
    const items = musicSearchState.results;
    if (!items.length) {
        const msg = musicSearchState.query
            ? (musicSearchState.searching ? '正在搜索…' : '没有找到「' + escapeHtml(musicSearchState.query) + '」的结果')
            : '输入歌名、歌手搜索；或点上面的热门标签试试';
        box.innerHTML = '<div class="music-empty">' + msg + '</div>';
        return;
    }
    box.innerHTML = items.map((item, index) => musicTrackRowHtml(item, index, 'search')).join('')
        + (musicSearchState.searching ? '<div class="music-empty">加载中…</div>' : '<button type="button" class="music-more" data-music-more>加载更多</button>');
}

function musicTrackRowHtml(item, index, context) {
    const key = escapeHtml(musicKey(item));
    const playing = musicPlayerCurrentItem() && musicKey(musicPlayerCurrentItem()) === musicKey(item);
    const offlineTag = (typeof musicDlTaskFor === 'function' && musicDlTaskFor(item)) ? '<span class="music-tag">下载中</span>' : '';
    return `<div class="music-row${playing ? ' playing' : ''}" data-music-key="${key}" data-music-ctx="${context}">
        <div class="music-row-play" data-music-play="${key}" role="button" aria-label="播放">
            <span class="music-row-num">${playing && musicState.playing ? '♫' : (index + 1)}</span>
        </div>
        <div class="music-row-art${item.artwork ? '' : ' no-art'}"${item.artwork ? ` style="background-image:url('${escapeHtml(item.artwork)}')"` : ''}></div>
        <div class="music-row-main">
            <div class="music-row-title">${escapeHtml(item.title || '未知曲名')}</div>
            <div class="music-row-sub">${escapeHtml([item.artist, item.album].filter(Boolean).join(' · '))}<span class="music-src">${escapeHtml(item.platform || '')}</span></div>
        </div>
        <div class="music-row-actions">
            <button type="button" class="music-row-btn" data-music-queue="${key}" title="加入队列">${musicIconPlay() === '' ? '' : '＋'}</button>
            <button type="button" class="music-row-btn" data-music-dl="${key}" title="下载">${musicIconDownload()}</button>
            <button type="button" class="music-row-btn" data-music-fav="${key}" title="收藏">♥</button>
        </div>
    </div>`;
}

// 用 key 找到当前结果/队列/收藏列表里的曲目对象
function musicFindItemByKey(key, context) {
    const match = item => musicKey(item) === key;
    if (context === 'queue') return musicState.queue.find(match) || null;
    if (context === 'favorites') return loadMusicFavorites().find(match) || null;
    if (context === 'downloads') return null; // 下载视图按存储 key 单独处理
    return musicSearchState.results.find(match) || null;
}

// ---------- 队列 / 收藏 / 下载 / 插件 ----------

function musicUIRenderQueue() {
    const box = document.getElementById('queueList');
    if (!box) return;
    if (!musicState.queue.length) {
        box.innerHTML = '<div class="music-empty">队列为空：在搜索结果里点 ＋ 加入</div>';
        return;
    }
    box.innerHTML = musicState.queue.map((item, index) => {
        const playing = index === musicState.index;
        return `<div class="music-row${playing ? ' playing' : ''}" data-music-key="${escapeHtml(musicKey(item))}" data-music-ctx="queue">
            <div class="music-row-play" data-music-queue-play="${index}" role="button" aria-label="播放">
                <span class="music-row-num">${playing && musicState.playing ? '♫' : (index + 1)}</span>
            </div>
            <div class="music-row-main">
                <div class="music-row-title">${escapeHtml(item.title || '')}</div>
                <div class="music-row-sub">${escapeHtml(item.artist || '')}<span class="music-src">${escapeHtml(item.platform || '')}</span></div>
            </div>
            <div class="music-row-actions">
                <button type="button" class="music-row-btn danger" data-music-queue-remove="${index}" title="移出队列">✕</button>
            </div>
        </div>`;
    }).join('');
}

function musicUIRenderFavorites() {
    const box = document.getElementById('favList');
    if (!box) return;
    const list = loadMusicFavorites();
    if (!list.length) {
        box.innerHTML = '<div class="music-empty">还没有收藏：点结果行里的 ♥</div>';
        return;
    }
    box.innerHTML = list.map((item, index) => musicTrackRowHtml(item, index, 'favorites')).join('');
}

function musicUIRenderDownloads() {
    const box = document.getElementById('dlList');
    if (!box) return;
    if (typeof indexedDB === 'undefined' || !indexedDB) {
        box.innerHTML = '<div class="music-empty">当前环境不支持 IndexedDB，离线下载不可用</div>';
        return;
    }
    musicDlList().then(rows => {
        const running = Array.from(musicDlTasks.entries()).filter(([, task]) => task.status === 'downloading');
        const runningHtml = running.map(([key, task]) => {
            const pct = task.total ? Math.min(100, Math.round(task.received / task.total * 100)) : 0;
            return `<div class="music-row"><div class="music-row-main">
                <div class="music-row-title">${escapeHtml((task.item && task.item.title) || '下载中')}</div>
                <div class="music-row-sub">${task.total ? pct + '% · ' + formatMusicBytes(task.received) : formatMusicBytes(task.received)}</div>
                <div class="music-progress"><i style="width:${pct}%"></i></div>
            </div></div>`;
        }).join('');
        if (!rows.length && !running.length) {
            box.innerHTML = '<div class="music-empty">还没有下载：点结果行里的 ↓</div>' ;
            return;
        }
        box.innerHTML = runningHtml + rows.map(row => {
            const item = row.item || {};
            const isFav = isMusicFavorite(item);
            return `<div class="music-row" data-dl-key="${escapeHtml(row.key)}">
                <div class="music-row-play" data-music-dl-play="${escapeHtml(row.key)}" role="button" aria-label="播放">
                    <span class="music-row-num">▶</span>
                </div>
                <div class="music-row-main">
                    <div class="music-row-title">${escapeHtml(item.title || '未知曲目')}</div>
                    <div class="music-row-sub">${escapeHtml(item.artist || '')} · ${formatMusicBytes(row.size)}<span class="music-src">${escapeHtml(item.platform || '')}</span></div>
                </div>
                <div class="music-row-actions">
                    <button type="button" class="music-row-btn" data-music-fav="${escapeHtml(musicKey(item))}" title="收藏">${isFav ? '♥' : '♡'}</button>
                    <button type="button" class="music-row-btn" data-music-dl-export="${escapeHtml(row.key)}" title="导出文件">⬇</button>
                    <button type="button" class="music-row-btn danger" data-music-dl-delete="${escapeHtml(row.key)}" title="删除">✕</button>
                </div>
            </div>`;
        }).join('');
    });
}

function musicUIRenderPlugins() {
    const box = document.getElementById('pluginList');
    if (!box) return;
    const sources = MusicPlugin.listMusicSources();
    box.innerHTML = sources.map(source => `
        <div class="music-plugin-row">
            <div class="music-row-main">
                <div class="music-row-title">${escapeHtml(source.platform)}${source.builtin ? '<span class="music-tag">内置</span>' : ''}</div>
                <div class="music-row-sub">v${escapeHtml(source.version || '?')}${source.disabled ? ' · 已禁用' : ''}</div>
            </div>
            <div class="music-row-actions">
                <button type="button" class="music-row-btn" data-music-source-toggle="${escapeHtml(source.platform)}">${source.disabled ? '启用' : '禁用'}</button>
                ${source.builtin ? '' : `<button type="button" class="music-row-btn danger" data-music-plugin-remove="${escapeHtml(source.platform)}">删除</button>`}
            </div>
        </div>`).join('');
}

// ---------- 事件绑定 ----------

function musicUIBind() {
    // Tab 切换
    document.querySelectorAll('[data-music-tab]').forEach(btn => {
        btn.addEventListener('click', () => musicUISetView(btn.dataset.musicTab));
    });

    // 搜索表单
    const searchForm = document.getElementById('musicSearchForm');
    const searchInput = document.getElementById('musicSearchInput');
    if (searchForm) {
        searchForm.addEventListener('submit', e => {
            e.preventDefault();
            const q = (searchInput && searchInput.value || '').trim();
            if (!q) return;
            musicUISetView('search');
            musicSearchStart(q);
        });
    }
    // 热门标签
    const hotRow = document.getElementById('musicHotTags');
    if (hotRow) {
        hotRow.innerHTML = MUSIC_HOT_KEYWORDS.map(kw => `<button type="button" class="chip" data-music-hot="${escapeHtml(kw)}">${escapeHtml(kw)}</button>`).join('');
        hotRow.addEventListener('click', e => {
            const chip = e.target.closest('[data-music-hot]');
            if (!chip) return;
            if (searchInput) searchInput.value = chip.dataset.musicHot;
            musicUISetView('search');
            musicSearchStart(chip.dataset.musicHot);
        });
    }

    // 结果区委托：播放/加队列/下载/收藏/加载更多
    const resultsBox = document.getElementById('searchResults');
    if (resultsBox) {
        resultsBox.addEventListener('click', e => {
            if (e.target.closest('[data-music-more]')) { musicSearchLoadMore(); return; }
            musicRowClickRouter(e, resultsBox, 'search');
        });
    }
    const favBox = document.getElementById('favList');
    if (favBox) favBox.addEventListener('click', e => musicRowClickRouter(e, favBox, 'favorites'));

    // 队列视图
    const queueBox = document.getElementById('queueList');
    if (queueBox) {
        queueBox.addEventListener('click', e => {
            const playAt = e.target.closest('[data-music-queue-play]');
            if (playAt) { musicPlayerPlayAt(parseInt(playAt.dataset.musicQueuePlay, 10)); return; }
            const removeAt = e.target.closest('[data-music-queue-remove]');
            if (removeAt) {
                musicQueueRemoveAt(parseInt(removeAt.dataset.musicQueueRemove, 10));
                musicUIRenderQueue();
                return;
            }
            const row = e.target.closest('[data-music-key]');
            if (row) {
                const item = musicFindItemByKey(row.dataset.musicKey, 'queue');
                if (item) musicPlayerPlayAt(musicState.queue.indexOf(item));
            }
        });
    }

    // 下载视图
    const dlBox = document.getElementById('dlList');
    if (dlBox) {
        dlBox.addEventListener('click', e => {
            const play = e.target.closest('[data-music-dl-play]');
            if (play) { musicDlPlayOffline(play.dataset.musicDlPlay); return; }
            const del = e.target.closest('[data-music-dl-delete]');
            if (del) {
                musicDlDelete(del.dataset.musicDlDelete).then(() => {
                    showToast('已删除', 'success');
                    musicUIRenderDownloads();
                });
                return;
            }
            const exp = e.target.closest('[data-music-dl-export]');
            if (exp) {
                musicDlExport(exp.dataset.musicDlExport).then(ok => {
                    if (!ok) showToast('导出失败', 'error');
                });
                return;
            }
            const fav = e.target.closest('[data-music-fav]');
            if (fav) { musicToggleFavoriteByKey(fav.dataset.musicFav); return; }
        });
    }

    // 插件视图
    const pluginBox = document.getElementById('pluginList');
    if (pluginBox) {
        pluginBox.addEventListener('click', e => {
            const toggle = e.target.closest('[data-music-source-toggle]');
            if (toggle) {
                MusicPlugin.setSourceDisabled(toggle.dataset.musicSourceToggle,
                    !MusicPlugin.listMusicSources().find(s => s.platform === toggle.dataset.musicSourceToggle).disabled);
                musicUIRenderPlugins();
                return;
            }
            const remove = e.target.closest('[data-music-plugin-remove]');
            if (remove) {
                MusicPlugin.removeMusicPlugin(remove.dataset.musicPluginRemove);
                musicUIRenderPlugins();
                showToast('插件已删除', 'success');
            }
        });
    }
    const importBtn = document.getElementById('pluginImportBtn');
    const importText = document.getElementById('pluginImportText');
    if (importBtn && importText) {
        importBtn.addEventListener('click', () => {
            const code = importText.value.trim();
            if (!code) { showToast('请粘贴插件 JS 内容', 'warning'); return; }
            try {
                const result = MusicPlugin.importMusicPlugin(code);
                importText.value = '';
                musicUIRenderPlugins();
                showToast('插件已导入：' + result.platform + (result.replaced ? '（覆盖旧版）' : ''), 'success');
            } catch (e) {
                showToast(e && e.message || '插件导入失败', 'error');
            }
        });
    }

    // 播放条
    const playBtn = document.getElementById('barPlayBtn');
    if (playBtn) playBtn.addEventListener('click', musicPlayerToggle);
    const prevBtn = document.getElementById('barPrevBtn');
    if (prevBtn) prevBtn.addEventListener('click', musicPlayerPlayPrev);
    const nextBtn = document.getElementById('barNextBtn');
    if (nextBtn) nextBtn.addEventListener('click', () => musicPlayerPlayNext(false));
    const progress = document.getElementById('musicProgress');
    if (progress) {
        progress.addEventListener('input', () => {
            const duration = musicPlayer.audio && isFinite(musicPlayer.audio.duration) ? musicPlayer.audio.duration : 0;
            if (duration) musicPlayerSeek(Number(progress.value));
        });
    }
    const lyricToggle = document.getElementById('barLyricBtn');
    const lyricPanel = document.getElementById('lyricsPanel');
    if (lyricToggle && lyricPanel) {
        lyricToggle.addEventListener('click', () => {
            lyricPanel.classList.toggle('hidden');
            if (!lyricPanel.classList.contains('hidden')) musicLyricsRender();
        });
        lyricPanel.addEventListener('click', e => {
            if (e.target === lyricPanel) lyricPanel.classList.add('hidden');
        });
    }
    const closeLyrics = document.getElementById('lyricsCloseBtn');
    if (closeLyrics && lyricPanel) closeLyrics.addEventListener('click', () => lyricPanel.classList.add('hidden'));

    // 下载状态变化刷新下载视图与播放条上的角标
    onMusicDlChange(() => {
        if (musicUIState.view === 'downloads') musicUIRenderDownloads();
    });
}

function musicRowClickRouter(e, root, context) {
    const fav = e.target.closest('[data-music-fav]');
    if (fav) { musicToggleFavoriteByKey(fav.dataset.musicFav); return; }
    const dl = e.target.closest('[data-music-dl]');
    if (dl) { musicDownloadByKey(dl.dataset.musicDl); return; }
    const queue = e.target.closest('[data-music-queue]');
    if (queue) { musicQueueByKey(queue.dataset.musicQueue); return; }
    const play = e.target.closest('[data-music-play]');
    if (play) {
        const item = musicFindItemByKey(play.dataset.musicPlay, context);
        if (item) musicSearchPlayAll(item);
        return;
    }
}

function musicToggleFavoriteByKey(key) {
    const item = musicFindItemByKey(key, 'search') || musicFindItemByKey(key, 'queue')
        || loadMusicFavorites().find(item => musicKey(item) === key) || null;
    if (!item) return;
    const nowFav = toggleMusicFavorite(item);
    showToast(nowFav ? '已收藏' : '已取消收藏', 'success');
    if (musicUIState.view === 'favorites') musicUIRenderFavorites();
    if (musicUIState.view === 'downloads') musicUIRenderDownloads();
}

function musicQueueByKey(key) {
    const item = musicFindItemByKey(key, 'search') || musicFindItemByKey(key, 'favorites');
    if (!item) return;
    musicQueueAppend(item);
    showToast('已加入队列', 'success');
    if (musicUIState.view === 'queue') musicUIRenderQueue();
}

function musicDownloadByKey(key) {
    const item = musicFindItemByKey(key, 'search') || musicFindItemByKey(key, 'favorites');
    if (!item) return;
    musicDownloadTrack(item).then(result => {
        if (result.ok) showToast('「' + (item.title || '') + '」已下载', 'success');
        else if (result.reason && result.reason !== '该曲目已下载' && result.reason !== '该曲目正在下载') {
            showToast('下载失败：' + result.reason, 'error');
        }
    });
}

// 从离线库直接播放（下载视图）
async function musicDlPlayOffline(key) {
    const record = await musicDlGet(key);
    if (!record || !record.blob) { showToast('离线文件不存在', 'error'); return; }
    const item = record.item || {};
    // 放进队列（若不在）再播，保持队列语义一致
    if (!musicState.queue.some(q => musicKey(q) === key)) {
        musicState.queue.push(Object.assign({}, item, { platform: item.platform, id: item.id }));
        musicState.index = musicState.queue.length - 1;
        saveMusicState();
    }
    const idx = musicState.queue.findIndex(q => musicKey(q) === key);
    musicState.index = idx;
    saveMusicState();
    const audio = musicPlayerEnsure();
    audio.pause();
    audio.src = URL.createObjectURL(record.blob);
    audio.play().catch(() => {});
    if (typeof musicPlayerUI !== 'undefined' && musicPlayerUI.onTrackChange) {
        musicPlayerUI.onTrackChange(musicState.queue[idx], idx);
    }
    if (typeof musicLyricsLoad === 'function') musicLyricsLoad(item);
}
