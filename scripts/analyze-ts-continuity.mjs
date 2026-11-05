#!/usr/bin/env node
/**
 * 实证分析：HLS 分片直拼成裸 TS 后，时间戳是否连续？
 * 电视端（三星 Tizen DLNA）直接消费拼接 TS，不像 hls.js 会重排时间戳。
 * 分析三件事（跨分片边界）：
 *   1) PTS/DTS 连续性（回跳/大跳 = 电视解码器中止的头号嫌疑）
 *   2) PCR 连续性（27MHz 时钟跳变）
 *   3) 连续计数器 CC（按 PID）
 * 用法: node scripts/analyze-ts-continuity.mjs <m3u8-url> [段数]
 */
import net from 'node:net';
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

let target = process.argv[2];
const maxSegs = parseInt(process.argv[3] || '8', 10);
const startIdx = parseInt(process.argv[4] || '0', 10);
if (!target) { console.error('用法: node analyze-ts-continuity.mjs <m3u8-url> [段数]'); process.exit(1); }

function fetchRaw(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.get(u, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36',
        'Accept': '*/*',
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirects > 5) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, u).toString();
        return resolve(fetchRaw(next, redirects + 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ body: Buffer.concat(chunks), status: res.statusCode, ct: res.headers['content-type'] || '' }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

function resolveUrl(base, rel) { return new URL(rel, base).toString(); }

function parsePlaylist(text, baseUrl) {
  const lines = text.split(/\r?\n/);
  const segs = [];
  let dur = 0;
  let discontinuity = false;
  const discAt = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#EXTINF:')) {
      dur = parseFloat(t.slice(8).split(',')[0]) || 0;
    } else if (t === '#EXT-X-DISCONTINUITY') {
      discontinuity = true; discAt.push(segs.length);
    } else if (t && !t.startsWith('#')) {
      segs.push({ url: resolveUrl(baseUrl, t), duration: dur, discBefore: discontinuity });
      discontinuity = false; dur = 0;
    }
  }
  const endlist = text.includes('#EXT-X-ENDLIST');
  return { segs, endlist, discAt };
}

// ---- TS 解析 ----
function* tsPackets(buf) {
  // 找到第一个 0x47 并按 188 步进；对每一步校验后续包同步字节
  let i = buf.indexOf(0x47);
  while (i >= 0 && i + 188 * 2 <= buf.length) {
    if (buf[i + 188] === 0x47) break;
    i = buf.indexOf(0x47, i + 1);
  }
  if (i < 0) return;
  for (; i + 188 <= buf.length; i += 188) {
    if (buf[i] !== 0x47) { // 失步，重新找
      i = buf.indexOf(0x47, i + 1) - 188;
      if (i < -188) break;
      continue;
    }
    yield buf.subarray(i, i + 188);
  }
}

function readTs(p) {
  const pid = ((p[1] & 0x1f) << 8) | p[2];
  const pusi = !!(p[1] & 0x40);
  const afc = (p[3] >> 4) & 3;
  const cc = p[3] & 0x0f;
  let afLen = 0, pcr = null, disc = false, payloadOff = 4;
  if (afc === 0) return null; // 保留值
  if (afc === 2 || afc === 3) {
    afLen = p[4];
    payloadOff = 5 + afLen;
    if (afLen > 0) {
      const flags = p[5];
      disc = !!(flags & 0x80);
      if (flags & 0x10) { // PCR
        let n = 0n;
        for (let k = 0; k < 6; k++) n = (n << 8n) | BigInt(p[6 + k]);
        pcr = { base: Number(n >> 15n) / 90000, ext: Number(n & 0x1ffn) };
      }
    }
  }
  if (afc === 2) return { pid, pusi, afc, cc, afLen, pcr, disc, payload: null };
  return { pid, pusi, afc, cc, afLen, pcr, disc, payload: p.subarray(payloadOff) };
}

function readPts5(b) {
  return ((b[0] >> 1) & 0x07) * 2 ** 30 + b[1] * 2 ** 22 + ((b[2] >> 1) & 0x7f) * 2 ** 15
    + b[3] * 2 ** 7 + ((b[4] >> 1) & 0x7f);
}

// 抽取一个分片内的 PES 时间戳与 CC 序列
function analyzeSegment(buf) {
  const perPid = new Map(); // pid -> {firstPts,lastPts,ptsCount,firstDts,dtsCount,ccSeq:[],pcrFirst,pcrLast,ccDiscs}
  for (const p of tsPackets(buf)) {
    const t = readTs(p);
    if (!t) continue;
    let st = perPid.get(t.pid);
    if (!st) { st = { firstPts: null, lastPts: null, ptsCount: 0, firstDts: null, lastDts: null, ccSeq: [], pcrFirst: null, pcrLast: null, pcrCount: 0 }; perPid.set(t.pid, st); }
    if (t.pcr) { st.pcrCount++; if (st.pcrFirst == null) st.pcrFirst = t.pcr.base; st.pcrLast = t.pcr.base; }
    if (t.payload && t.pid !== 0x1fff) st.ccSeq.push(t.cc);
    if (t.payload && t.pusi && t.payload.length > 14 && t.payload[0] === 0 && t.payload[1] === 0 && t.payload[2] === 1) {
      const sid = t.payload[3];
      if (sid !== 0xbc && sid !== 0xbe && sid !== 0xf0 && sid !== 0xf1 && sid !== 0xff && sid !== 0xf2) {
        const scram = (t.payload[6] >> 4) & 3; // 加扰位在 5-4,6-7 是固定标记 '10'
        if (scram === 0 && (t.payload[6] & 0xc0) === 0x80) { // '10'xxxxxx
          const flags = t.payload[7];
          const ptsdts = (flags >> 6) & 3;
          if (ptsdts >= 2 && t.payload.length >= 14) {
            const pts = readPts5(t.payload.subarray(9, 14)) / 90000;
            if (st.firstPts == null) st.firstPts = pts;
            st.lastPts = pts; st.ptsCount++;
            if (ptsdts === 3 && t.payload.length >= 19) {
              const dts = readPts5(t.payload.subarray(14, 19)) / 90000;
              if (st.firstDts == null) st.firstDts = dts;
              st.lastDts = dts;
            }
          }
        }
      }
    }
  }
  return perPid;
}

const fmt = (s) => (s == null ? '  --  ' : `${s.toFixed(3).padStart(8)}s`);

console.log(`== 拉取清单: ${target}`);
// master 清单 → 媒体清单（最多向下解 3 层）
for (let hop = 0; hop < 3; hop++) {
  const pl0 = await fetchRaw(target);
  const t0 = pl0.body.toString('utf8');
  if (t0.includes('#EXT-X-STREAM-INF')) {
    const m = t0.split(/\r?\n/).filter((l) => l.trim() && !l.trim().startsWith('#')).pop();
    target = resolveUrl(target, m.trim());
    console.log(`   master → 媒体清单: ${target}`);
    continue;
  }
  var pl = { body: pl0.body, status: pl0.status, ct: pl0.ct };
  break;
}
console.log(`   HTTP ${pl.status} · ${pl.body.length} 字节 · ${pl.ct}`);
const text = pl.body.toString('utf8');
if (!text.includes('#EXTM3U')) { console.error('不是 m3u8'); process.exit(2); }
const { segs, endlist, discAt } = parsePlaylist(text, target);
console.log(`   分片 ${segs.length} · ENDLIST=${endlist} · 显式 DISCONTINUITY 标签 ${discAt.length} 处${discAt.length ? ' @' + discAt.join(',') : ''}`);

const n = Math.min(maxSegs, Math.max(0, segs.length - startIdx));
console.log(`== 并行下载分片 ${startIdx}..${startIdx + n - 1} 并解析 TS …`);
const picked = [];
for (let i = startIdx; i < startIdx + n; i++) picked.push({ idx: i, ...segs[i] });

const results = new Array(n);
let done = 0;
async function dlOne(item) {
  try {
    const r = await fetchRaw(item.url);
    const sizeMB = r.body.length / 1048576;
    const info = analyzeSegment(r.body);
    results[item.idx] = { size: r.body.length, sizeMB, info };
  } catch (e) {
    results[item.idx] = { error: String(e.message || e) };
  }
  done++;
  console.log(`   [${done}/${n}] #${item.idx} ${results[item.idx].error ? 'ERR ' + results[item.idx].error : results[item.idx].sizeMB.toFixed(2) + 'MB'}`);
}
// 4 路并发
const queue = [...picked];
await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
  while (queue.length) { const it = queue.shift(); await dlOne(it); }
}));

// 选主视频 PID（PTS 计数最多的 PID）
const tally = new Map();
for (const r of results) {
  if (!r || !r.info) continue;
  for (const [pid, st] of r.info) tally.set(pid, (tally.get(pid) || 0) + st.ptsCount);
}
const pids = [...tally.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]);
console.log(`\n== 按 PID 汇总（含 PTS 的 PES 数）: ${[...tally.entries()].sort((a, b) => b[1] - a[1]).map(([p, c]) => `0x${p.toString(16)}(${c})`).join(' ')}`);

for (const pid of pids) {
  console.log(`\n### PID 0x${pid.toString(16)} 跨分片时间戳连续性`);
  let prev = null;
  let backJumps = 0, fwdBigJumps = 0, ccErrs = 0;
  for (const r of results) {
    if (!r || !r.info) { prev = null; continue; }
    const st = r.info.get(pid);
    if (!st || st.ptsCount === 0) { prev = null; continue; }
    const idx = results.indexOf(r);
    const discNote = picked[idx] && picked[idx].discBefore ? '〔DISCONT〕' : '';
    if (prev) {
      const d = st.firstPts - prev.lastPts;
      const dDts = st.firstDts != null && prev.lastDts != null ? st.firstDts - prev.lastDts : null;
      const mark = d < -0.05 ? '⬅回跳!' : (d > 3 ? '⬆大跳!' : '');
      const dtsMark = dDts != null && (dDts < -0.05 || dDts > 3) ? `⬅DTS跳(${dDts.toFixed(3)})!` : '';
      if (d < -0.05) backJumps++;
      if (d > 3) fwdBigJumps++;
      if (dtsMark) backJumps++;
      // CC 期望
      const expNext = (prev.lastCc + 1) & 0x0f;
      const ccMark = st.ccSeq.length && expNext !== st.ccSeq[0] ? 'CC断!' : '';
      if (ccMark) ccErrs++;
      console.log(`   边界${discNote}: PTS ${fmt(prev.lastPts)}→${fmt(st.firstPts)} Δ=${d >= 0 ? '+' : ''}${d.toFixed(3)}s ${mark}${ccMark}${dtsMark}${dtsMark && !dtsMark.includes('DTS跳') ? '' : dDts != null ? ` (DTS Δ=${dDts >= 0 ? '+' : ''}${dDts.toFixed(3)})` : ''}`);
    }
    // 片内单调性
    let mono = true;
    for (let k = 1; k < st.ccSeq.length; k++) { /* cc 只作参考 */ }
    console.log(`   片 #${results.indexOf(r)}: PTS ${fmt(st.firstPts)} → ${fmt(st.lastPts)} (${st.ptsCount} PES) · PCR ${st.pcrCount} 个 ${st.pcrFirst != null ? `${st.pcrFirst.toFixed(3)}→${st.pcrLast.toFixed(3)}s` : ''} · 分片 ${r.sizeMB.toFixed(2)}MB`);
    prev = { lastPts: st.lastPts, lastCc: st.ccSeq.length ? st.ccSeq[st.ccSeq.length - 1] : null };
  }
  console.log(`   —— 结论: 回跳 ${backJumps} 处, >3s 前跳 ${fwdBigJumps} 处, CC 断裂 ${ccErrs} 处`);
}

// PCR 连续性（主 PID）
console.log(`\n### PCR 跨分片连续性`);
let prevPcr = null;
for (const r of results) {
  if (!r || !r.info) { prevPcr = null; continue; }
  const st = r.info.get(pids[0]);
  if (!st || st.pcrFirst == null) { prevPcr = null; continue; }
  if (prevPcr != null) {
    const d = st.pcrFirst - prevPcr;
    if (d < -0.05 || d > 3) console.log(`   ⚠ PCR 边界跳变: ${prevPcr.toFixed(3)}s → ${st.pcrFirst.toFixed(3)}s (Δ${d >= 0 ? '+' : ''}${d.toFixed(3)}s)`);
  }
  prevPcr = st.pcrLast;
}
console.log('\n== 完成。回跳/大跳即电视解码中止（ERROR_OCCURRED）的直接嫌疑。');
