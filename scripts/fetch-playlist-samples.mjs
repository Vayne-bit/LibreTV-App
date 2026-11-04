// 抓取真实站源的 m3u8 清单样本，用于广告过滤误判率实测
import fs from 'node:fs';
import path from 'node:path';

const OUT = process.argv[2] || path.join(process.cwd(), 'samples');
fs.mkdirSync(OUT, { recursive: true });

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const SITES = [
  ['ryi', 'https://cj.rycjapi.com'],
  ['360zy', 'https://360zy.com'],
  ['bfzy', 'https://bfzyapi.com'],
  ['tyyszy', 'https://tyyszy.com'],
  ['xiaomaomi', 'https://zy.xiaomaomi.cc'],
  ['heimuer', 'https://json.heimuer.xyz'],
  ['wolong', 'https://wolongzyw.com'],
  ['hwba', 'https://cjhwba.com'],
  ['jisu', 'https://jszyapi.com'],
  ['dbzy', 'https://dbzy.com'],
  ['mozhua', 'https://mozhuazy.com'],
  ['dyttzy', 'http://caiji.dyttzyapi.com'],
];

const KEYWORDS = ['庆余年', '猫武士', '西游记', '斗罗大陆', '三体', '狂飙', '琅琊榜', '肖申克的救赎', '泰坦尼克号', '复仇者联盟', '甄嬛传', '狂人日记', '神雕侠侣', '天龙八部', '盗墓笔记', '鬼吹灯', '大江大河', '觉醒年代', '山海情', '知否知否'];

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

// master 清单里挑一条码率最高的变体，追到真正的媒体清单
function pickVariant(text, baseUrl) {
  const lines = text.split('\n');
  let bestBw = -1, bestUri = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t.startsWith('#EXT-X-STREAM-INF')) continue;
    const bw = parseInt((t.match(/BANDWIDTH=(\d+)/) || [])[1] || '0', 10);
    // 下一条非注释行就是变体地址
    for (let j = i + 1; j < lines.length; j++) {
      const u = lines[j].trim();
      if (!u || u.startsWith('#')) continue;
      if (bw > bestBw) { bestBw = bw; bestUri = u; }
      break;
    }
  }
  if (!bestUri) return null;
  try { return new URL(bestUri, baseUrl).href; } catch (e) { return null; }
}

// 从详情 JSON 里抠出 m3u8（可能带 $ 分隔、可能有多个剧集）
function extractM3u8(jsonText) {
  const out = [];
  try {
    const data = JSON.parse(jsonText);
    const list = data.list || [];
    for (const item of list) {
      const fromField = [item.vod_play_url, item.vod_play_from, item.vod_play_note]
        .filter(Boolean).join(' ');
      const re = /\$([^$\s"']+\.m3u8)/gi;
      let m;
      while ((m = re.exec(fromField))) out.push(m[1]);
      // 也可能直接是裸 m3u8 字段
      if (!out.length) {
        const re2 = /https?:\/\/[^\s"'<>]+\.m3u8/gi;
        while ((m = re2.exec(fromField))) out.push(m[0]);
      }
    }
  } catch (e) { /* 非 JSON，忽略 */ }
  return [...new Set(out)];
}

const manifest = [];
let stats = { sites: 0, lists: 0, ok: 0, fail: 0 };

// 每站按关键词轮换取样：不同片子的广告插入策略可能不同，
// 只取搜索结果第一个会集中在同一部剧上，样本说服力不足。
const PER_SITE = 8;

for (const [name, base] of SITES) {
  stats.sites++;
  let found = 0;
  let kwIdx = 0;
  for (const kw of KEYWORDS) {
    if (found >= PER_SITE) break;
    const enc = encodeURIComponent(kw);
    const r = await get(`${base}/api.php/provide/vod/?ac=videolist&wd=${enc}`);
    if (r.status !== 200 || !r.text) continue;
    const urls = extractM3u8(r.text);
    // 这个关键词下最多取 2 条，保证片源分散
    let takenHere = 0;
    for (const u of urls) {
      if (found >= PER_SITE || takenHere >= 2) break;
      let m = await get(u, 15000);
      if (m.status !== 200 || !m.text || !m.text.includes('#EXTM3U')) continue;
      // master 清单 → 追到媒体清单（分片明细在这里）
      let finalUrl = u;
      if (m.text.includes('#EXT-X-STREAM-INF')) {
        const variant = pickVariant(m.text, u);
        if (!variant) continue;
        const m2 = await get(variant, 15000);
        if (m2.status !== 200 || !m2.text || !m2.text.includes('#EXTINF')) continue;
        m = m2; finalUrl = variant;
      } else if (!m.text.includes('#EXTINF')) {
        continue;
      }
      const file = path.join(OUT, `${name}_${found}_${Date.now()}.m3u8`);
      fs.writeFileSync(file, m.text, 'utf8');
      manifest.push({ site: name, keyword: kw, url: finalUrl, file: path.basename(file), bytes: m.text.length });
      found++;
      takenHere++;
      stats.lists++;
      stats.ok++;
    }
  }
  console.error(`[${name}] 抓到 ${found} 个清单`);
}

fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
console.error(`完成：${stats.ok}/${stats.lists} 个清单已保存到 ${OUT}`);
