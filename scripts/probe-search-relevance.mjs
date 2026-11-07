// 复现用户问题：全源检索「千与千寻」，逐源分析返回结果的相关度与成人内容
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';
import fs from 'node:fs';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36';
const QUERY = process.argv[2] || '千与千寻';

function req(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request(u, { headers: { 'User-Agent': UA, Accept: 'application/json' }, timeout: timeoutMs }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, body: Buffer.alloc(0), error: 'timeout' }); });
    r.on('error', (e) => resolve({ status: 0, body: Buffer.alloc(0), error: e.message }));
    r.end();
  });
}

// 从 config.js 提取源列表（简单正则，避免引入浏览器环境）
const cfg = fs.readFileSync('public/js/config.js', 'utf8');
const sources = [];
const siteRe = /\n\s{4}(\w+):\s*\{\s*\n\s*api:\s*'([^']+)'/g;
let m;
while ((m = siteRe.exec(cfg)) !== null) {
  if (m[1] !== 'testSource') sources.push({ code: m[1], api: m[2] });
}
console.log(`配置源 ${sources.length} 个，检索词「${QUERY}」\n`);

const adultWords = /(伦理|激情|福利姬|写真|麻豆|蜜桃|威 cream|淫|欲|诱惑|出租|伴游|援交|wa|丝袜|巨乳|人妻|熟女|插|做爱|AV|av)/i;
const kw = QUERY.replace(/\s+/g, '');

let total = 0, exact = 0, fuzzy = 0, irrelevant = 0, adult = 0;
const irrelevantSamples = [];

for (const { code, api } of sources) {
  const url = `${api}/api.php/provide/vod/?ac=videolist&wd=${encodeURIComponent(QUERY)}`;
  const r = await req(url);
  if (r.status !== 200) { console.log(`${code.padEnd(12)} ✗ HTTP ${r.status}${r.error ? ' ' + r.error : ''}`); continue; }
  let j;
  try { j = JSON.parse(r.body.toString('utf8')); } catch (e) { console.log(`${code.padEnd(12)} ✗ 非JSON`); continue; }
  const list = j.list || [];
  const titles = [];
  for (const item of list) {
    total++;
    const name = String(item.vod_name || '').trim();
    const nameClean = name.replace(/[\s·・:：，,－—-]/g, '').toLowerCase();
    const hit = nameClean.includes(kw.toLowerCase()) || kw.toLowerCase().includes(nameClean) && nameClean.length >= Math.min(4, kw.length);
    if (nameClean === kw.toLowerCase()) exact++;
    else if (hit) fuzzy++;
    else {
      irrelevant++;
      titles.push(name);
      if (adultWords.test(name)) adult++;
      if (irrelevantSamples.length < 40) irrelevantSamples.push(`[${code}] ${name} (${item.vod_remarks || ''})`);
    }
  }
  console.log(`${code.padEnd(12)} ${list.length} 条${list.length ? '，不相关 ' + titles.length : ''}${titles.length ? ' → ' + titles.slice(0, 5).join(' / ') : ''}`);
}

console.log(`\n== 汇总: 共 ${total} 条 | 完全匹配 ${exact} | 模糊相关 ${fuzzy} | 不相关 ${irrelevant}（其中疑似成人 ${adult}）`);
if (irrelevantSamples.length) {
  console.log('\n== 不相关样本（前 40）:');
  irrelevantSamples.forEach(s => console.log('  ' + s));
}
