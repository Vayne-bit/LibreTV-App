import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import dns from 'dns';
import net from 'net';
import cors from 'cors';
import axios from 'axios';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const port = 8080;

const LOG_FILE_PATH = path.join(__dirname, 'proxy_debug.log');
// 安全说明：调试日志会把所有被代理的 URL（即用户看过的片源）明文落盘，
// 属于隐私风险。默认关闭，需要时设 PROXY_DEBUG=1 启动：node server.mjs
const DEBUG_LOG = process.env.PROXY_DEBUG === '1';
if (DEBUG_LOG) {
  try {
    fs.writeFileSync(LOG_FILE_PATH, `Server log started at ${new Date().toISOString()} (Version with sync body read)\n`);
  } catch (err) {
    console.error('Failed to clear/initialize log file:', err);
  }
}

function appendToLogFile(message) {
  if (!DEBUG_LOG) return;
  try {
    fs.appendFileSync(LOG_FILE_PATH, `${new Date().toISOString()} - ${message}\n`);
  } catch (err) {
    console.error('Failed to write to log file, logging to console instead:', err);
    console.log(`[LOG_FILE_FALLBACK] ${message}`);
  }
}

// Helper function to read a stream into a string
async function streamToString(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

app.use(cors());

// docker-entrypoint.sh / middleware.js 都会把 index.html 里的 {{PASSWORD}} 占位符
// 替换成实际配置；node server.mjs 这条部署路径一直没有做替换——配置了密码
// 却静默不生效（isPasswordProtected 要求 64 位哈希，占位符只有 12 字符）。
// 所以静态服务 index.html 前在这里做同样的替换（PASSWORD 为 64 位 hex）。
const SERVER_PASSWORD = (process.env.PASSWORD || '').trim();
function serveIndex(res) {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (!fs.existsSync(indexPath)) {
    const errMsg = 'index.html not found in public directory';
    console.error(errMsg);
    appendToLogFile(errMsg);
    return res.status(404).send(errMsg);
  }
  if (!SERVER_PASSWORD) {
    return res.sendFile(indexPath);
  }
  let html = fs.readFileSync(indexPath, 'utf8');
  html = html.split('{{PASSWORD}}').join(SERVER_PASSWORD);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}

app.get('/', (req, res) => {
  const message = '[Server] Root path / was accessed.';
  console.log(message);
  appendToLogFile(message);
  serveIndex(res);
});

app.get('/proxy/:encodedUrl', async (req, res) => {
  const routeMatchLog = `[Proxy Server ENTRY] Route /proxy/:encodedUrl matched. Encoded URL param: ${req.params.encodedUrl}, Path: ${req.path}`;
  console.log(routeMatchLog);
  appendToLogFile(routeMatchLog);

  try {
    const encodedUrl = req.params.encodedUrl;
    const targetUrl = decodeURIComponent(encodedUrl);

    const validationLog = `[Proxy Server] Decoded target URL: ${targetUrl}`;
    console.log(validationLog);
    appendToLogFile(validationLog);

    const isValidUrl = (urlString) => {
      try {
        const parsed = new URL(urlString);
        const allowedProtocols = ['http:', 'https:'];
        if (!allowedProtocols.includes(parsed.protocol)) return false;
        const hostname = parsed.hostname.toLowerCase();
        // 只拦 localhost 不够：开放代理会把整个内网（路由器/NAS/摄像头等）
        // 暴露给任意访问者（SSRF）。这里一并拦截私网与链路本地地址。
        if (hostname === 'localhost' || hostname.endsWith('.local') || hostname.endsWith('.internal')) return false;
        if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(hostname)) return false;
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)) return false;
        if (hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:')) return false;
        if (hostname === '[::1]') return false;
        return true;
      } catch {
        return false;
      }
    };

    // 域名形态检查挡不住「特殊写法」：十进制 IP（http://2130706433/ = 127.0.0.1）、
    // 十六进制/八进制段、IPv6 映射地址（[::ffff:127.0.0.1]）都能骗过字符串匹配，
    // DNS 重绑定也会在这里现形。所以最终以「解析出来的真实 IP」为准做放行判断。
    const isPrivateIp = (ip) => {
      if (net.isIPv4(ip)) {
        const [a, b] = ip.split('.').map(Number);
        return a === 0 || a === 10 || a === 127
          || (a === 100 && b >= 64 && b <= 127)
          || (a === 169 && b === 254)
          || (a === 172 && b >= 16 && b <= 31)
          || (a === 192 && b === 168);
      }
      const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
      if (lower === '::' || lower === '::1') return true;
      if (lower.startsWith('fe80') || lower.startsWith('fc') || lower.startsWith('fd')) return true;
      // IPv4 映射/兼容地址（::ffff:127.0.0.1 等）
      const v4mapped = lower.match(/(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
      if (v4mapped) return isPrivateIp(v4mapped[1]);
      return false;
    };
    const resolveTargetIps = async (urlString) => {
      const hostname = new URL(urlString).hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(hostname)) return [hostname];
      return new Promise((resolve) => {
        dns.lookup(hostname, { all: true }, (err, addresses) => {
          resolve(err ? [] : (addresses || []).map(item => item.address));
        });
      });
    };

    if (!isValidUrl(targetUrl)) {
      const invalidUrlMsg = `[Proxy Server] Invalid URL attempted: ${targetUrl}`;
      console.error(invalidUrlMsg);
      appendToLogFile(invalidUrlMsg);
      return res.status(400).send('Invalid URL');
    }

    // 以解析出的真实 IP 做最终裁决（防十进制/十六进制 IP、IPv6 映射、DNS 重绑定绕过）
    const targetIps = await resolveTargetIps(targetUrl);
    if (!targetIps.length || targetIps.some(ip => isPrivateIp(ip))) {
      const blockedMsg = `[Proxy Server] Target resolves to private/unresolvable address, blocked: ${targetUrl} -> ${targetIps.join(',') || 'no-answer'}`;
      console.error(blockedMsg);
      appendToLogFile(blockedMsg);
      return res.status(400).send('Invalid URL');
    }

    const userAgent = req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 Edg/114.0.1823.51';
    const requestHeaders = {
      'User-Agent': userAgent,
      'Accept': req.headers.accept || '*/*',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    };

    const axiosRequestLog = `[Proxy Server] Making GET request to ${targetUrl} with headers: ${JSON.stringify(requestHeaders)}`;
    console.log(axiosRequestLog);
    appendToLogFile(axiosRequestLog);

    const response = await axios({
      method: 'get',
      url: targetUrl,
      headers: requestHeaders,
      responseType: 'stream',
      timeout: 15000,
      validateStatus: function (status) {
        return status >= 200 && status < 500; 
      }
    });

    const responseStatusLog = `[Proxy Server] Response from ${targetUrl} - Status: ${response.status}, Headers: ${JSON.stringify(response.headers)}`;
    console.log(responseStatusLog);
    appendToLogFile(responseStatusLog);

    const contentType = response.headers['content-type'];
    const responseBody = await streamToString(response.data); // Read the full body first
    const trimmedBody = responseBody.trim();

    const isJsonContentType = contentType && (contentType.includes('application/json') || contentType.includes('application/javascript'));
    const contentTypeDebugMsg = `[Proxy Server DEBUG] Target URL: ${targetUrl}, Content-Type: '${contentType}', isJsonContentType: ${isJsonContentType}, Body length: ${trimmedBody.length}`;
    console.log(contentTypeDebugMsg);
    appendToLogFile(contentTypeDebugMsg);

    if (isJsonContentType) {
      try {
        const jsonData = JSON.parse(trimmedBody); // Parse the already read body
        const sendJsonLog = `[Proxy Server] Sending (originally JSON Content-Type) parsed JSON response from ${targetUrl} to client.`;
        console.log(sendJsonLog);
        appendToLogFile(sendJsonLog);
        res.status(response.status).json(jsonData);
      } catch (parseError) {
        const parseErrorLog = `[Proxy Server] Failed to parse JSON response from ${targetUrl} (Content-Type was JSON). Error: ${parseError.message}. Body preview: ${trimmedBody.substring(0, 500)}`;
        console.error(parseErrorLog);
        appendToLogFile(parseErrorLog);
        res.status(500).json({ error: true, message: 'Proxy failed to parse upstream JSON response despite JSON Content-Type.' });
      }
    } else { // Handle non-JSON declared content types
      const nonJsonInitialLog = `[Proxy Server] Target API at ${targetUrl} (status ${response.status}) returned non-JSON content-type: '${contentType}'. Attempting to parse body as JSON.`;
      console.warn(nonJsonInitialLog);
      appendToLogFile(nonJsonInitialLog);
      try {
        const jsonData = JSON.parse(trimmedBody);
        const recoveredJsonLog = `[Proxy Server] Successfully parsed non-JSON (Content-Type: ${contentType}) response from ${targetUrl} as JSON. Sending to client with status ${response.status}.`;
        console.log(recoveredJsonLog);
        appendToLogFile(recoveredJsonLog);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.status(response.status).json(jsonData);
      } catch (parseError) {
        const finalErrorMsg = `[Proxy Server] Failed to parse non-JSON response body from ${targetUrl} as JSON (Content-Type: ${contentType}, Status: ${response.status}). Error: ${parseError.message}. Sending 502.`;
        console.error(finalErrorMsg);
        appendToLogFile(finalErrorMsg);
        res.status(502).json({
          error: true,
          message: 'Proxied API returned content that could not be parsed as JSON.',
          target_url: targetUrl,
          target_status: response.status,
          target_content_type: contentType,
          target_body_preview: trimmedBody.substring(0, 200)
        });
      }
    }
  } catch (error) {
    const errorMsg = `[Proxy Server] CATCH BLOCK Error for encodedUrl ${req.params.encodedUrl}: ${error.message}`;
    console.error(errorMsg);
    appendToLogFile(errorMsg);

    if (error.isAxiosError && error.response) { // Error from target server (e.g., 4xx, 5xx that didn't pass validateStatus, or network error if responseType was not stream and parsing failed)
      const errResponseLog = `[Proxy Server] Error response from target (in catch, axios error): Status ${error.response.status}, Headers: ${JSON.stringify(error.response.headers)}`;
      console.error(errResponseLog);
      appendToLogFile(errResponseLog);
      // Try to send what the target server sent, if it's a stream (though with responseType: 'stream' it should always be)
      if (error.response.data && typeof error.response.data.pipe === 'function') {
         if (!res.headersSent) {
            res.status(error.response.status);
            if (error.response.headers['content-type']) {
                res.setHeader('Content-Type', error.response.headers['content-type']);
            }
            error.response.data.pipe(res);
        } else {
            appendToLogFile(`[Proxy Server] Headers already sent, cannot pipe error response from target for ${targetUrl}`);
        }
      } else if (error.response.data) {
         if (!res.headersSent) {
            res.status(error.response.status).send(error.response.data);
        } else {
            appendToLogFile(`[Proxy Server] Headers already sent, cannot send error data from target for ${targetUrl}`);
        }
      } else {
         if (!res.headersSent) {
            res.status(error.response.status || 500).send(error.message);
        }
      }
    } else if (error.request) { // The request was made but no response was received
      const noResponseLog = `[Proxy Server] No response received (in catch) from target for ${decodeURIComponent(req.params.encodedUrl)}: ${error.code || error.message}`;
      console.error(noResponseLog);
      appendToLogFile(noResponseLog);
      if (!res.headersSent) {
        res.status(504).send(`Proxy timeout or network error: ${error.code || error.message}`);
      }
    } else { // Something else happened in setting up the request
      const setupErrorLog = `[Proxy Server] Error setting up request (in catch) for ${decodeURIComponent(req.params.encodedUrl)}: ${error.message}`;
      console.error(setupErrorLog);
      appendToLogFile(setupErrorLog);
      if (!res.headersSent) {
        res.status(500).send(`Proxy setup error: ${error.message}`);
      }
    }
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(port, '0.0.0.0', () => {
  const startupMsg = `Server running at http://0.0.0.0:${port} (accessible on your local network).${DEBUG_LOG ? ' Debug log: ' + LOG_FILE_PATH : ' Debug log disabled (set PROXY_DEBUG=1 to enable)'}`;
  console.log(startupMsg);
  appendToLogFile(startupMsg);
});
