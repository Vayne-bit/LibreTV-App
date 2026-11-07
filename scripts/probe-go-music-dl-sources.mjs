// 实证探测 go-music-dl 风格的公开音乐平台 API（酷我/咪咕），确定哪些可集成
import https from 'node:https';
import http from 'node:http';
import { URL } from 'node:url';

const UA = 'Mozilla/5.0 (Linux; Android 16; 2210132C) AppleWebKit/537.36 Chrome/156.0 Mobile Safari/537.36';

function req(url, opts = {}, redirectCount = 0) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const r = mod.request(u, {
      method: opts.method || 'GET',
      headers: { 'User-Agent': UA, ...(opts.headers || {}) },
      timeout: 12000,
    }, (res) => {
      // 手动跟随重定向（跨跳带 cookie：kuwo 首页 302 后才发 kw_token）
      if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location && redirectCount < 5) {
        res.resume();
        const next = new URL(res.headers.location, u).toString();
        const cookie = (res.headers['set-cookie'] || []).map(String).join('; ');
        const merged = { ...opts.headers };
        if (cookie) merged.Cookie = merged.Cookie ? merged.Cookie + '; ' + cookie.split('; ').filter(c => !/^(Path|Domain|Expires|Max-Age|Secure|HttpOnly)/i.test(c)).join('; ') : cookie.split('; ').filter(c => !/^(Path|Domain|Expires|Max-Age|Secure|HttpOnly)/i.test(c)).join('; ');
        return resolve(req(next, { ...opts, headers: merged }, redirectCount + 1));
      }
      const c = [];
      res.on('data', (d) => c.push(d));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(c),
      }));
    });
    r.on('timeout', () => { r.destroy(); resolve({ status: 0, error: 'timeout' }); });
    r.on('error', (e) => resolve({ status: 0, error: e.message }));
    r.end();
  });
}

const out = (label, v) => console.log(label.padEnd(46), v);

// ---- 酷我：www API 需要 kw_token cookie + csrf 头 ----
console.log('== 酷我 kuwo ==');
const home = await req('https://www.kuwo.cn/', { headers: { Referer: 'https://www.kuwo.cn/' } });
const setCookie = home.headers && (home.headers['set-cookie'] || []);
const kwToken = (setCookie.map(String).find(c => c.includes('kw_token=')) || '').split('kw_token=')[1]?.split(';')[0] || '';
out('首页状态', home.status);
out('kw_token', kwToken ? '获取成功(' + kwToken.slice(0, 8) + '...)' : '未拿到');

if (kwToken) {
  const search = await req('https://www.kuwo.cn/api/www/search/searchMusicBykeyWord?key=' + encodeURIComponent('周杰伦 晴天') + '&pn=1&rn=10', {
    headers: {
      Referer: 'https://www.kuwo.cn/',
      Cookie: `kw_token=${kwToken}`,
      csrf: kwToken,
    },
  });
  out('搜索状态', search.status);
  try {
    const j = JSON.parse(search.body.toString('utf8'));
    const list = (j.data && j.data.list) || [];
    out('搜索结果数', list.length);
    if (list.length) {
      const first = list[0];
      out('首条', `${first.name} - ${first.artist} (rid=${first.rid}, 音乐id=${first.musicrid || first.id})`);
      // 播放地址
      const rid = String(first.musicrid || first.rid || '').replace('MUSIC_', '');
      const play = await req(`https://www.kuwo.cn/api/v1/www/music/playUrl?mid=${rid}&type=music&httpsStatus=1`, {
        headers: { Referer: 'https://www.kuwo.cn/', Cookie: `kw_token=${kwToken}`, csrf: kwToken },
      });
      out('播放URL接口状态', play.status);
      try {
        const pj = JSON.parse(play.body.toString('utf8'));
        const purl = pj.data && pj.data.url;
        out('播放URL', purl ? purl.slice(0, 80) + '...' : JSON.stringify(pj).slice(0, 120));
        if (purl) {
          const head = await req(purl, { method: 'HEAD' });
          out('直链探测', `HTTP ${head.status} ${head.headers['content-type'] || ''} ${(head.headers['content-length'] || 0) / 1048576 | 0}MB`);
        }
      } catch (e) { out('播放URL解析', '失败 ' + e.message); }
    }
  } catch (e) { out('搜索解析', '失败 ' + e.message + ' | ' + search.body.toString('utf8').slice(0, 120)); }
}

// ---- 咪咕 migu ----
console.log('\n== 咪咕 migu ==');
const miguSearch = await req('https://m.music.migu.cn/migu/remoting/scr_search_tag?rows=10&type=2&keyword=' + encodeURIComponent('周杰伦 晴天') + '&pgc=1', {
  headers: { Referer: 'https://m.music.migu.cn/v3/search' },
});
out('搜索状态', miguSearch.status);
try {
  const j = JSON.parse(miguSearch.body.toString('utf8'));
  const list = (j.musics || []);
  out('搜索结果数', list.length);
  if (list.length) {
    const first = list[0];
    out('首条', `${(first.songName || '').replace(/<[^>]+>/g, '')} - ${(first.singerName || '').replace(/<[^>]+>/g, '')}`);
    // 常见: first.full hears: listenUrl / newRateFormats
    const candidates = [first.listenUrl, first.newRateFormats && first.newRateFormats[0] && first.newRateFormats[0].url].filter(Boolean);
    out('直链字段', candidates.length ? candidates[0].slice(0, 80) + '...' : '(见响应结构)');
    if (candidates[0]) {
      const p = candidates[0].startsWith('//') ? 'https:' + candidates[0] : candidates[0];
      const head = await req(p, { method: 'HEAD' });
      out('直链探测', `HTTP ${head.status} ${head.headers['content-type'] || ''}`);
    }
  }
} catch (e) { out('搜索解析', '失败 ' + e.message + ' | ' + miguSearch.body.toString('utf8').slice(0, 120)); }
