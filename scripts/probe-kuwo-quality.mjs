// 酷我音质/完整度深挖：不同 br 的 mobi.s + https 备用 playUrl（跟重定向）
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const UA = 'Mozilla/5.0 (Linux; Android 16) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36';

function req(url, opts = {}, redirectCount = 0) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request(u, { method: opts.method || 'GET', headers: { 'User-Agent': UA, ...(opts.headers || {}) }, timeout: 15000 }, (res) => {
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirectCount < 5) {
        res.resume();
        return resolve(req(new URL(res.headers.location, u).toString(), opts, redirectCount + 1));
      }
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.end();
  });
}

const rid = '228908'; // 晴天 - 周杰伦
for (const br of ['128kmp3', '192kmp3', '320kmp3', '2000kmp3', '4000kflac']) {
  const r = await req('https://mobi.kuwo.cn/mobi.s?f=web&source=kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk&from=PC&type=convert_url_with_sign&br=' + br + '&rid=' + rid + '&user=C_APK_guanwang_1');
  try {
    const j = JSON.parse(r.body.toString('utf8'));
    const d = j.data || {};
    if (d.url) {
      const head = await req(d.url, { method: 'HEAD' });
      console.log(br.padEnd(10), `→ HTTP ${head.status} ${(head.headers['content-length'] || 0) / 1048576}MB ${head.headers['content-type'] || ''} | bitrate=${d.bitrate} format=${d.format}`);
    } else {
      console.log(br.padEnd(10), '→ 无url', JSON.stringify(j).slice(0, 90));
    }
  } catch (e) { console.log(br.padEnd(10), '解析失败', r.body.toString('utf8').slice(0, 90)); }
}
console.log('--- https playUrl 备用（跟重定向）:');
const fb = await req('https://www.kuwo.cn/api/v1/www/music/playUrl?mid=' + rid + '&type=music&httpsStatus=1', {
  headers: { Cookie: 'kw_token=secret_token', Secret: 'kuwo_web_secret', Referer: 'https://www.kuwo.cn/' },
});
try {
  const j = JSON.parse(fb.body.toString('utf8'));
  const d = j.data || {};
  if (d.url) {
    const head = await req(d.url, { method: 'HEAD' });
    console.log('playUrl →', `HTTP ${head.status} ${(head.headers['content-length'] || 0) / 1048576}MB ${head.headers['content-type'] || ''}`);
  } else console.log('playUrl → 无url', JSON.stringify(j).slice(0, 120));
} catch (e) { console.log('playUrl 解析失败', fb.body.toString('utf8').slice(0, 120)); }
