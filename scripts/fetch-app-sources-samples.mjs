// 全自动采集 LibreTV 应用内全部源站的样本（与 public/js/config.js 的 API_SITES 对齐）：
//   搜索 → 详情 → 提取播放地址（JSON / HTML 兜底）→ 跟进 master→媒体清单
// 每站尽量取同一部剧的前 3 集（供跨集广告投票实测）。
// 产出：<out>/manifest.json（元数据）+ <out>/<site>_<n>.m3u8（媒体清单原文）
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || path.join(process.cwd(), 'samples_fresh');
fs.mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

// 与 public/js/config.js API_SITES 一致（排除 testSource 与 adult 注释源）
const SITES = [
  ['dyttzy', 'http://caiji.dyttzyapi.com'],
  ['ruyi', 'https://cj.rycjapi.com'],
  ['bfzy', 'https://bfzyapi.com'],
  ['tyyszy', 'https://tyyszy.com'],
  ['xiaomaomi', 'https://zy.xiaomaomi.cc'],
  ['ffzy', 'http://ffzy5.tv'],
  ['heimuer', 'https://json.heimuer.xyz'],
  ['zy360', 'https://360zy.com'],
  ['wolong', 'https://wolongzyw.com'],
  ['hwba', 'https://cjhwba.com'],
  ['jisu', 'https://jszyapi.com'],
  ['dbzy', 'https://dbzy.com'],
  ['mozhua', 'https://mozhuazy.com'],
  ['mdzy', 'https://www.mdzyapi.com'],
  ['zuid', 'https://api.zuidapi.com'],
  ['yinghua', 'https://m3u8.apiyhzy.com'],
  ['baidu', 'https://api.apibdzy.com'],
  ['wujin', 'https://api.wujinapi.me'],
  ['wwzy', 'https://wwzy.tv'],
  ['ikun', 'https://ikunzyapi.com'],
];

const KEYWORDS = ['西游记', '狂飙', '甄嬛传', '斗罗大陆', '庆余年', '三体', '琅琊榜', '神雕侠侣', '天龙八部', '盗墓笔记'];
const EPISODES = 3; // 同一部剧取前 3 集：跨集广告投票的实测基础

async function get(url, timeout = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': UA, Accept: 'application/json,text/html,*/*' },
    });
    if (!res.ok) return { status: res.status, text: '' };
    return { status: res.status, text: await res.text() };
  } catch (e) {
    return { status: 0, text: '', error: String(e.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

function resolveUrl(base, target) {
  try {
    return new URL(target, base).href;
  } catch {
    return target;
  }
}

// 搜索关键词 → 第一部有播放地址的剧（返回 {id, name, playUrls[]}）
async function findPlayable(api, detailBase) {
  for (const kw of KEYWORDS) {
    const r = await get(`${api}/api.php/provide/vod/?ac=videolist&wd=${encodeURIComponent(kw)}`);
    if (r.status !== 200 || !r.text) continue;
    let data;
    try {
      data = JSON.parse(r.text);
    } catch {
      continue;
    }
    const list = (data && Array.isArray(data.list)) ? data.list : [];
    for (const item of list.slice(0, 3)) {
      const urls = parsePlayUrls(item.vod_play_url || '');
      if (urls.length) return { id: item.vod_id, name: item.vod_name, keyword: kw, urls };
    }
    // JSON 源没有可用地址时，再试 HTML 详情页抓取（ffzy/heimuer 形态）
    if (list.length) {
      const scraped = await scrapeDetailPlayUrls(detailBase || api, list[0].vod_id);
      if (scraped.length) {
        return { id: list[0].vod_id, name: list[0].vod_name, keyword: kw, urls: scraped };
      }
    }
  }
  return null;
}

// vod_play_url: "线路1$u1#u2#u3$$$线路2$..." → 第一条线路的分集地址
function parsePlayUrls(play) {
  const firstLine = (play || '').split('$$$')[0] || '';
  return firstLine.split('#').map(ep => {
    const parts = ep.split('$');
    return parts.length > 1 ? parts[1] : '';
  }).filter(u => /^https?:\/\//.test(u));
}

// HTML 详情页兜底抓 m3u8（与前端 vipFetchDetail 同款正则）
async function scrapeDetailPlayUrls(base, id) {
  const r = await get(`${base}/index.php/vod/detail/id/${id}.html`);
  if (r.status !== 200 || !r.text) return [];
  let matches = r.text.match(/\$(https?:\/\/[^"'\s]+?\/\d{8}\/\d+_[a-f0-9]+\/index\.m3u8)/g) || [];
  if (!matches.length) matches = r.text.match(/\$(https?:\/\/[^"'\s]+?\.m3u8)/g) || [];
  const uniq = [];
  const seen = new Set();
  for (const m of matches) {
    let link = m.substring(1);
    const p = link.indexOf('(');
    if (p > 0) link = link.substring(0, p);
    if (!seen.has(link)) { seen.add(link); uniq.push(link); }
  }
  return uniq;
}

// master 清单里挑码率最高的变体，追到媒体清单
function pickVariant(text, baseUrl) {
  const lines = text.split('\n');
  let bestBw = -1, bestUri = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = parseInt((t.match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
    for (let j = i + 1; j < lines.length; j++) {
      const u = lines[j].trim();
      if (!u || u.startsWith('#')) continue;
      if (bw > bestBw) { bestBw = bw; bestUri = u; }
      break;
    }
  }
  return bestUri ? resolveUrl(baseUrl, bestUri) : null;
}

async function followToMedia(url, depth = 0) {
  if (depth > 3) return { url, text: '', error: '嵌套过深' };
  const r = await get(url);
  if (r.status !== 200 || !r.text) return { url, text: '', error: `HTTP ${r.status}` };
  const text = r.text;
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variant = pickVariant(text, url);
    if (!variant) return { url, text, error: 'master 无变体' };
    return followToMedia(variant, depth + 1);
  }
  if (!text.includes('#EXTINF') && !text.includes('#EXT-X-TARGETDURATION')) {
    return { url, text, error: '不是 HLS 媒体清单' };
  }
  return { url, text };
}

function playlistStats(text) {
  const lines = text.split('\n').map(l => l.trim());
  const segs = lines.filter(l => l && !l.startsWith('#'));
  return {
    segments: segs.length,
    discontinuity: lines.filter(l => l === '#EXT-X-DISCONTINUITY').length,
    keyNone: lines.filter(l => l.startsWith('#EXT-X-KEY:') && /METHOD=NONE/i.test(l)).length,
    keyAes: lines.filter(l => l.startsWith('#EXT-X-KEY:') && /METHOD=(AES|SAMPLE-AES)/i.test(l)).length,
    mapTags: lines.filter(l => l.startsWith('#EXT-X-MAP')).length,
    cueTags: lines.filter(l => l.startsWith('#EXT-X-CUE')).length + lines.filter(l => l.includes('SCTE35')).length,
  };
}

const manifest = [];
for (const [site, api] of SITES) {
  const found = await findPlayable(api, api);
  if (!found) {
    manifest.push({ site, status: 'no-playable-result' });
    console.log(`[fetch] ${site}: 未找到可播结果`);
    continue;
  }
  const urls = found.urls.slice(0, EPISODES);
  for (let i = 0; i < urls.length; i++) {
    const playUrl = urls[i];
    const media = await followToMedia(playUrl);
    // 非 HLS 内容（如返回 HTML 播放页的源）必须跳过：只看 text 非空会把
    // HTML 页当清单存下来，污染下游测量与投屏模拟
    if (!media.text || media.error) {
      manifest.push({ site, keyword: found.keyword, vodName: found.name, episode: i + 1, playUrl, status: `unreachable: ${media.error || 'empty'}` });
      console.log(`[fetch] ${site} ep${i + 1}: 拉流失败 ${media.error || 'empty'}`);
      continue;
    }
    if (!media.text.includes('#EXTM3U')) {
      manifest.push({ site, keyword: found.keyword, vodName: found.name, episode: i + 1, playUrl, status: 'not-a-playlist(HTML?)' });
      console.log(`[fetch] ${site} ep${i + 1}: 非 HLS 内容，跳过`);
      continue;
    }
    const stats = playlistStats(media.text);
    const file = `${site}_${i}.m3u8`;
    fs.writeFileSync(path.join(OUT, file), media.text, 'utf8');
    manifest.push({
      site, keyword: found.keyword, vodName: found.name, episode: i + 1,
      playUrl, mediaUrl: media.url, file, bytes: media.text.length, status: 'ok', ...stats,
    });
    console.log(`[fetch] ${site} ep${i + 1}: ${stats.segments}片 ${stats.discontinuity}断点 ${stats.keyNone}个KEY:NONE ${stats.mapTags}个MAP → ${file}`);
  }
}
fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
const ok = manifest.filter(m => m.status === 'ok');
console.log(`\n[fetch] 完成: ${ok.length} 份媒体清单 / ${SITES.length} 站，覆盖 ${new Set(ok.map(m => m.site)).size} 站`);
