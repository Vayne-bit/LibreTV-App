// 实测 music-lib 的酷我/咪咕端点（搜索→播放直链→可达性），能通的才集成
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const UA = 'Mozilla/5.0 (Linux; Android 16; 2210132C) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36';
const out = (label, v) => console.log(label.padEnd(30), v);

function req(url, opts = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request(u, { method: 'GET', headers: { 'User-Agent': UA, ...(opts.headers || {}) }, timeout: 15000 }, (res) => {
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(c) }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.end();
  });
}

// ---- 酷我 ----
console.log('== 酷我 ==');
const KW = '周杰伦 晴天';
const kwSearch = await req('http://search.kuwo.cn/r.s?all=' + encodeURIComponent(KW) +
  '&ft=music&itemset=web_2013&client=kt&pcmp4=1&geo=c&vipver=1&pn=0&rn=10&rformat=json&encoding=utf8');
out('搜索状态', kwSearch.status);
let kwFirst = null;
try {
  const legacy = kwSearch.body.toString('utf8').replace(/'/g, '"');
  const j = JSON.parse(legacy);
  const list = (j.abslist || j.list || []);
  out('结果数', list.length);
  if (list.length) {
    kwFirst = list[0];
    out('首条', `${kwFirst.SONGNAME || kwFirst.name} - ${kwFirst.ARTIST || kwFirst.artist} rid=${kwFirst.DC_TARGETID || kwFirst.rid || kwFirst.MUSICRID}`);
  }
} catch (e) { out('解析', '失败 ' + e.message + ' | ' + kwSearch.body.toString('utf8').slice(0, 150)); }

if (kwFirst) {
  const rid = String(kwFirst.MUSICRID || kwFirst.DC_TARGETID || kwFirst.rid || '').replace(/^MUSIC_/, '');
  out('rid', rid);
  // 主路径 mobi.s
  const mobi = await req('https://mobi.kuwo.cn/mobi.s?f=web&source=kwplayercar_ar_6.0.0.9_B_jiakong_vh.apk&from=PC&type=convert_url_with_sign&br=2000kmp3&rid=' + rid + '&user=C_APK_guanwang_1');
  out('mobi.s 状态', mobi.status);
  try {
    const mj = JSON.parse(mobi.body.toString('utf8'));
    const murl = mj.data && mj.data.url;
    if (murl) {
      const head = await req(murl, { method: 'HEAD' });
      out('mobi.s 直链', `HTTP ${head.status} ${head.headers['content-type'] || ''} ${((head.headers['content-length'] || 0) / 1048576).toFixed(1)}MB`);
    } else out('mobi.s 直链', '空 ' + JSON.stringify(mj).slice(0, 100));
  } catch (e) { out('mobi.s 解析', '失败 ' + mobi.body.toString('utf8').slice(0, 100)); }
  // 备用 playUrl
  const fb = await req('http://www.kuwo.cn/api/v1/www/music/playUrl?mid=' + rid + '&type=music&httpsStatus=1', {
    headers: { Cookie: 'kw_token=secret_token', Secret: 'kuwo_web_secret', Referer: 'https://www.kuwo.cn/' },
  });
  out('playUrl 备用状态', fb.status);
  try {
    const fj = JSON.parse(fb.body.toString('utf8'));
    const furl = fj.data && fj.data.url;
    if (furl) {
      const head = await req(furl, { method: 'HEAD' });
      out('备用直链', `HTTP ${head.status} ${head.headers['content-type'] || ''} ${((head.headers['content-length'] || 0) / 1048576).toFixed(1)}MB`);
    } else out('备用直链', '空 ' + JSON.stringify(fj).slice(0, 100));
  } catch (e) { out('备用解析', '失败 ' + fb.body.toString('utf8').slice(0, 100)); }
}

// ---- 咪咕 ----
console.log('\n== 咪咕 ==');
const sw = encodeURIComponent('{"song":1,"album":0,"singer":0,"tagSong":0,"mvSong":0,"songlist":0,"bestShow":1}');
const mgSearch = await req('http://pd.musicapp.migu.cn/MIGUM2.0/v1.0/content/search_all.do?ua=Android_migu&version=5.0.1&text=' +
  encodeURIComponent('周杰伦 晴天') + '&pageNo=1&pageSize=10&searchSwitch=' + sw, {
  headers: { Referer: 'http://m.music.migu.cn/' },
});
out('搜索状态', mgSearch.status);
try {
  const j = JSON.parse(mgSearch.body.toString('utf8'));
  const list = (j.songResultData && j.songResultData.result) || [];
  out('结果数', list.length);
  if (list.length) {
    const first = list[0];
    const name = String(first.songName || first.name || '').replace(/<[^>]+>/g, '');
    const singer = String(first.singerName || '').replace(/<[^>]+>/g, '');
    out('首条', `${name} - ${singer} (id=${first.songId || first.copyrightId})`);
    const rates = first.newRateFormats || [];
    out('音质档', rates.map(r => r.formatType + ':' + (r.url ? '有' : '无')).join(' '));
    const pick = rates.find(r => r.url) || first.listenUrl;
    if (pick && pick.url) {
      const purl = pick.url.startsWith('//') ? 'https:' + pick.url : pick.url;
      const head = await req(purl, { method: 'HEAD' });
      out('直链探测', `HTTP ${head.status} ${head.headers['content-type'] || ''} ${((head.headers['content-length'] || 0) / 1048576).toFixed(1)}MB`);
    } else out('直链', '无');
  }
} catch (e) { out('解析', '失败 ' + e.message + ' | ' + mgSearch.body.toString('utf8').slice(0, 150)); }
