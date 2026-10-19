// LibreTV 跨设备同步云函数（Cloudflare Workers + KV）
// 只做认证和存取，合并逻辑全部在客户端
//
// 接口：
//   POST /sync/new            生成新的同步码与 token
//   GET  /sync/{code}         拉取（需 X-Sync-Token）
//   PUT  /sync/{code}         上传（需 X-Sync-Token）
//   DELETE /sync/{code}       注销同步组（需 X-Sync-Token）

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 去掉 I/O/0/1 等易混字符
const TTL_SECONDS = 60 * 60 * 24 * 365; // 一年不活跃自动清理
const MAX_BODY_BYTES = 512 * 1024;      // 单次同步上限 512KB

export default {
  async fetch(request, env) {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,PUT,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,X-Sync-Token'
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '');

    try {
      // 浏览器直接打开根路径时给个说明，避免以为是故障
      if ((path === '' || path === '/') && request.method === 'GET') {
        return json({
          ok: true,
          service: 'libretv-sync',
          hint: '这是同步服务接口，请在 App 的设置页填写本地址。浏览器访问 /sync/new 返回 bad path 属正常现象（该接口只接受 POST）。'
        }, 200, cors);
      }

      // --- 生成新码 ---
      if (path === '/sync/new') {
        if (request.method !== 'POST') {
          return json({
            error: 'method not allowed',
            hint: '/sync/new 只接受 POST。用 App 里的「创建同步码」按钮，或 curl -X POST 调用。'
          }, 405, cors);
        }
        const code = randomCode();
        const token = randomToken();
        await env.SYNC_KV.put(
          kvKey(code),
          JSON.stringify({ tokenHash: await sha256(token), updatedAt: 0, data: null }),
          { expirationTtl: TTL_SECONDS }
        );
        return json({ code, token }, 200, cors);
      }

      // --- 带码的操作 ---
      const match = path.match(/^\/sync\/([A-Za-z0-9-]{6,20})$/);
      if (!match) return json({ error: 'bad path' }, 404, cors);

      const code = match[1].toUpperCase();
      const token = request.headers.get('X-Sync-Token') || '';
      const key = kvKey(code);
      const raw = await env.SYNC_KV.get(key);

      if (request.method === 'GET') {
        if (!raw) return json({ error: 'not found' }, 404, cors);
        const record = JSON.parse(raw);
        if (!(await tokenMatches(record, token))) return json({ error: 'unauthorized' }, 401, cors);
        return json({ code, updatedAt: record.updatedAt, data: record.data }, 200, cors);
      }

      if (request.method === 'PUT') {
        if (!raw) return json({ error: 'not found' }, 404, cors);
        const record = JSON.parse(raw);
        if (!(await tokenMatches(record, token))) return json({ error: 'unauthorized' }, 401, cors);

        const text = await request.text();
        if (text.length > MAX_BODY_BYTES) return json({ error: 'too large' }, 413, cors);

        let body;
        try {
          body = JSON.parse(text);
        } catch (e) {
          return json({ error: 'bad json' }, 400, cors);
        }

        // 整体只做后写胜出的保护，逐条合并由客户端负责
        if (typeof body.updatedAt !== 'number') return json({ error: 'missing updatedAt' }, 400, cors);
        if (body.data === undefined || body.data === null) return json({ error: 'missing data' }, 400, cors);
        if (body.updatedAt < record.updatedAt) {
          return json({ error: 'stale', serverUpdatedAt: record.updatedAt }, 409, cors);
        }

        record.updatedAt = body.updatedAt;
        record.data = body.data;
        await env.SYNC_KV.put(key, JSON.stringify(record), { expirationTtl: TTL_SECONDS });
        return json({ ok: true, updatedAt: record.updatedAt }, 200, cors);
      }

      if (request.method === 'DELETE') {
        if (!raw) return json({ error: 'not found' }, 404, cors);
        const record = JSON.parse(raw);
        if (!(await tokenMatches(record, token))) return json({ error: 'unauthorized' }, 401, cors);
        await env.SYNC_KV.delete(key);
        return json({ ok: true }, 200, cors);
      }

      return json({ error: 'method not allowed' }, 405, cors);
    } catch (e) {
      return json({ error: 'server error', detail: String(e && e.message ? e.message : e) }, 500, cors);
    }
  }
};

function kvKey(code) {
  return `sync:${code}`;
}

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors }
  });
}

async function tokenMatches(record, token) {
  if (!record || !record.tokenHash) return false;
  if (!token) return false;
  return record.tokenHash === (await sha256(token));
}

// 8 位随机码，约 40 bit 熵，写成 XXXX-XXXX 方便抄写
function randomCode() {
  let s = '';
  for (let i = 0; i < 8; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return `${s.slice(0, 4)}-${s.slice(4)}`;
}

// 24 字节随机 token，48 位十六进制
function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
