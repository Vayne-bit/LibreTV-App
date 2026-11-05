// 实证：分片 35/36/37/38 的 CDN 可达性与耗时（对账 total_bytes 冻结在 35/36 边界的假说）
import https from 'node:https';

const UA = 'Mozilla/5.0 (Linux; Android 16) Mobile';
let T0 = Date.now();
function get(url, ms) {
  return new Promise((res, rej) => {
    T0 = Date.now();
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (r) => {
      if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
      const c = [];
      r.on('data', (d) => c.push(d));
      r.on('end', () => res({ buf: Buffer.concat(c), ms: Date.now() - T0 }));
      r.on('error', rej);
    });
    req.on('error', rej);
    req.setTimeout(ms, () => req.destroy(new Error('TIMEOUT ' + ms + 'ms')));
  });
}

const plr = await get('https://vip.dytt-hot.com/20250213/72013_e835617a/3000k/hls/mixed.m3u8', 15000);
const pl = plr.buf;
console.log('清单字节:', pl.length, '头 40:', JSON.stringify(pl.toString().slice(0, 40)));
const lines = pl.toString().split(/\r?\n/);
const exts = lines.filter((l) => l.startsWith('#EXTINF')).map((l) => parseFloat(l.slice(8)));
const segs = lines.filter((l) => l.trim() && !l.startsWith('#'));
const base = 'https://vip.dytt-hot.com/20250213/72013_e835617a/3000k/hls/';
const u = (i) => new URL(segs[i], base).toString();
console.log('分片35:', u(35).slice(-46));
console.log('分片36:', u(36).slice(-46));
console.log('时长 34/35/36/37:', exts.slice(34, 38).join(' / '));
for (const i of [34, 35, 36, 37, 38, 42]) {
  try {
    const r = await get(u(i), 20000);
    console.log(`分片${i}: ${(r.buf.length / 1048576).toFixed(2)}MB in ${r.ms}ms (${Math.round(r.buf.length / 1024 / (r.ms / 1000))}KB/s)`);
  } catch (e) { console.log(`分片${i}: 失败 - ${e.message}`); }
}
