// A/B 实证：同一 CDN，6 个分片并行取流 —— HTTP/1.1（6 条独立 TCP 连接，
// 各自拥塞窗口）vs HTTP/2（单连接多路复用，共享一个拥塞窗口）。
// 决定是否给 reqwest 开 http2 feature。
import https from 'node:https';
import http2 from 'node:http2';
import { URL } from 'node:url';

const UA = 'Mozilla/5.0 (Linux; Android 16) Mobile';
const BASE = 'https://vip.dytt-hot.com/20250213/72013_e835617a/3000k/hls/mixed.m3u8';

function getH1(url, ms = 30000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const req = https.get(url, { headers: { 'User-Agent': UA } }, (r) => {
      const c = [];
      r.on('data', (d) => c.push(d));
      r.on('end', () => res({ n: Buffer.concat(c).length, ms: Date.now() - t0, proto: r.httpVersion }));
      r.on('error', rej);
    });
    req.on('error', rej);
    req.setTimeout(ms, () => req.destroy(new Error('timeout')));
  });
}

function getH2(client, url, ms = 30000) {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const req = client.request({ ':path': new URL(url).pathname + new URL(url).search, 'user-agent': UA });
    let n = 0;
    req.on('response', () => {
      req.on('data', (d) => { n += d.length; });
      req.on('end', () => res({ n, ms: Date.now() - t0 }));
    });
    req.on('error', rej);
    req.setTimeout(ms, () => { req.close(); rej(new Error('timeout')); });
    req.end();
  });
}

// 拿分片列表
const pl = await getH1(BASE);
const body = await new Promise((res) => {
  const req = https.get(BASE, { headers: { 'User-Agent': UA } }, (r) => {
    const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res(Buffer.concat(c)));
  });
});
const lines = body.toString().split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('#'));
const base = 'https://vip.dytt-hot.com/20250213/72013_e835617a/3000k/hls/';
const urls = [];
for (let i = 0; i < 6; i++) urls.push(new URL(lines[5 + i], base).toString());
console.log('6 个分片:', urls.map((u) => u.split('/').pop().slice(0, 12)).join(' '));

// —— A: h1 6 并行 ——
let T = Date.now();
const h1Results = await Promise.all(urls.map((u) => getH1(u)));
const h1Wall = Date.now() - T;
const h1Bytes = h1Results.reduce((s, r) => s + r.n, 0);
console.log(`A/h1 并行: 墙钟 ${h1Wall}ms  总计 ${(h1Bytes / 1048576).toFixed(2)}MB  有效 ${Math.round(h1Bytes / 1024 / (h1Wall / 1000))}KB/s  (单流 ${h1Results.map((r) => Math.round(r.n / 1024 / (r.ms / 1000))).join('/')}KB/s)`);

// —— B: h2 单连接多路复用（不等待，6 流同发）——
T = Date.now();
const client = http2.connect('https://vip.dytt-hot.com');
await new Promise((res, rej) => { client.on('connect', res); client.on('error', rej); });
const h2Results = await Promise.all(urls.map((u) => getH2(client, u)));
const h2Wall = Date.now() - T;
const h2Bytes = h2Results.reduce((s, r) => s + r.n, 0);
console.log(`B/h2 复用: 墙钟 ${h2Wall}ms  总计 ${(h2Bytes / 1048576).toFixed(2)}MB  有效 ${Math.round(h2Bytes / 1024 / (h2Wall / 1000))}KB/s  (单流 ${h2Results.map((r) => Math.round(r.n / 1024 / (r.ms / 1000))).join('/')}KB/s)`);
client.close();

console.log(`\n结论: ${h1Wall <= h2Wall ? 'h1 并行更快或相当 (' + h1Wall + 'ms vs ' + h2Wall + 'ms) —— 「6 路独立连接」的抗劣化能力更强' : 'h2 复用更快 (' + h2Wall + 'ms vs ' + h1Wall + 'ms)'}`);
