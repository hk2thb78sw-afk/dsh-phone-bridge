// 局域网入口：配对门槛 + 反向代理到本机 DSH Web 服务。
// 代理会重写 Host / Origin / Referer / Cookie，使上游 127.0.0.1 的信任栅栏照常通过，
// 再把上游的 HTML 响应注入手机端样式。
import http from 'node:http';
import net from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
import { desktopPage, machinesPage, pairPage } from './pages.js';
import { qrSvg } from './qr.js';
import { scanLan } from './scan.js';

// 插件版本，跟 package.json 同步；用来核对「正在运行的到底是哪一版」。
export const BRIDGE_VERSION = '0.3.4';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

// 与上游一致：静态资源本身是公开的，不参与配对门槛；
// 否则浏览器在拿清单/图标时不带 cookie，会 401。
const PUBLIC_PATHS = ['/manifest.webmanifest', '/favicon.svg', '/favicon-dark.svg', '/favicon.ico', '/apple-touch-icon.png'];
const PUBLIC_PREFIXES = ['/assets/', '/plugins/'];

function isPublicAsset(pathname) {
  return PUBLIC_PATHS.includes(pathname) || PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function fallbackAddresses(port) {
  const result = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      result.push(`http://${entry.address}:${port}`);
    }
  }
  return result;
}

function readBody(req, limit = 1 << 20) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendHtml(res, status, html) {
  const body = Buffer.from(html);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  });
  res.end(body);
}

/**
 * @param {object} options
 * @param {number} options.port 局域网监听端口
 * @param {string} options.bind 监听地址（默认 0.0.0.0）
 * @param {number} options.upstreamPort 本机 DSH Web 端口
 * @param {import('./pairing.js').Pairing} options.pairing
 * @param {() => Promise<string>} options.getCookie 取得可用的 DSH 认证 cookie
 * @param {(html: string) => string} options.transformHtml 给上游 HTML 注入手机端样式
 * @param {(message: string) => void} [options.log]
 */
export function createLanServer(options) {
  const { port, bind, upstreamPort, pairing, getCookie, transformHtml, log, resolveAddresses } = options;
  const lanAddresses = async () => {
    if (typeof resolveAddresses === 'function') {
      try {
        const rows = await resolveAddresses();
        if (rows.length > 0) return rows.map((row) => `http://${row.address}:${port}`);
      } catch {}
    }
    return fallbackAddresses(port);
  };
  const authority = `127.0.0.1:${upstreamPort}`;
  const agent = new http.Agent({ keepAlive: true, maxSockets: 128 });
  const sockets = new Set();
  let cookieCache = '';

  const refreshCookie = async (force = false) => {
    if (!force && cookieCache) return cookieCache;
    cookieCache = await getCookie();
    return cookieCache;
  };

  const pairingPage = async () => {
    const code = pairing.currentCode();
    return pairPage({
      addresses: await lanAddresses(),
      expiresAt: code.expiresAt,
      hasCode: true,
    });
  };

  const authorize = (req) => {
    const device = pairing.deviceFrom(req.headers);
    if (device) pairing.touch(device);
    return device;
  };

  async function handleControl(req, res, pathname) {
    const remote = req.socket.remoteAddress;
    const loopback = isLoopback(remote);

    if (pathname === '/__phone/pair' && req.method === 'POST') {
      if (pairing.blocked(remote)) {
        sendJson(res, 429, { ok: false, reason: 'blocked', message: '尝试次数过多，请 5 分钟后再试' });
        return true;
      }
      let payload = {};
      try {
        payload = JSON.parse((await readBody(req)).trim() || '{}');
      } catch {}
      const result = pairing.pair(payload.code, req.headers['user-agent']);
      if (!result.ok) {
        pairing.recordFailure(remote);
        const message = result.reason === 'expired' ? '配对码已过期，请在电脑上刷新' : '配对码不正确';
        sendJson(res, 401, { ok: false, reason: result.reason, message });
        return true;
      }
      pairing.recordSuccess(remote);
      const cookie = result.cookie;
      res.setHeader(
        'set-cookie',
        `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
      );
      sendJson(res, 200, { ok: true, label: result.device.label });
      log?.(`手机已配对: ${result.device.label}`);
      return true;
    }

    // 公开的「局域网目录」接口：只暴露机器名和地址，不含任何凭据或配对状态。
    if (pathname === '/__phone/identity' && req.method === 'GET') {
      sendJson(res, 200, { app: 'dsh-phone-bridge', name: hostname(), port, version: BRIDGE_VERSION });
      return true;
    }

    if (pathname === '/__phone/scan' && req.method === 'GET') {
      const refresh = new URL(req.url ?? '/', 'http://phone-bridge.internal').searchParams.has('refresh');
      try {
        const rows = typeof resolveAddresses === 'function' ? await resolveAddresses() : [];
        const result = await scanLan({ port, force: refresh, interfaces: rows });
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
      }
      return true;
    }

    if (pathname === '/__phone/machines' && req.method === 'GET') {
      sendHtml(res, 200, machinesPage({ port }));
      return true;
    }

    // 其余控制接口只允许本机访问（配对页在电脑上打开）。
    if (!loopback) {
      sendJson(res, 403, { ok: false, reason: 'loopback-only' });
      return true;
    }

    if (pathname === '/__phone/health' && req.method === 'GET') {
      try {
        await Promise.race([
          getCookie(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
        ]);
        sendJson(res, 200, { ok: true, version: BRIDGE_VERSION });
      } catch (error) {
        sendJson(res, 503, { ok: false, version: BRIDGE_VERSION, error: String(error?.message ?? error) });
      }
      return true;
    }

    if (pathname === '/__phone/status' && req.method === 'GET') {
      const code = pairing.currentCode();
      sendJson(res, 200, {
        ok: true,
        version: BRIDGE_VERSION,
        port,
        upstreamPort,
        addresses: await lanAddresses(),
        code: code.value,
        expiresAt: code.expiresAt,
        devices: pairing.devices,
      });
      return true;
    }

    if (pathname === '/__phone/desktop' && req.method === 'GET') {
      sendHtml(res, 200, desktopPage({ port, upstreamPort, addresses: await lanAddresses() }));
      return true;
    }

    // 配对二维码：只允许本机读取，内容里带当前配对码。
    if (pathname === '/__phone/qr.svg' && req.method === 'GET') {
      const allowed = await lanAddresses();
      const requested = new URL(req.url ?? '/', 'http://phone-bridge.internal').searchParams.get('host');
      const host = allowed.map((item) => item.replace(/^http:\/\//, '')).includes(requested)
        ? requested
        : allowed[0]?.replace(/^http:\/\//, '') ?? `127.0.0.1:${port}`;
      const code = pairing.currentCode();
      const link = `http://${host}/?pair=${code.value}`;
      const svg = qrSvg(link, { scale: 6, margin: 3 });
      res.writeHead(200, { 'content-type': 'image/svg+xml; charset=utf-8', 'cache-control': 'no-store' });
      res.end(svg);
      return true;
    }

    if (pathname === '/__phone/rotate' && req.method === 'POST') {
      const code = pairing.rotateCode();
      sendJson(res, 200, { ok: true, code: code.value, expiresAt: code.expiresAt });
      return true;
    }

    if (pathname === '/__phone/revoke' && req.method === 'POST') {
      let payload = {};
      try {
        payload = JSON.parse((await readBody(req)).trim() || '{}');
      } catch {}
      const revoked = payload.id === '*' ? (pairing.revokeAll(), true) : pairing.revoke(String(payload.id ?? ''));
      sendJson(res, 200, { ok: true, revoked, devices: pairing.devices });
      return true;
    }

    sendJson(res, 404, { ok: false, reason: 'not-found' });
    return true;
  }

  function buildHeaders(req, cookie) {
    const headers = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (HOP_BY_HOP.has(name)) continue;
      headers[name] = value;
    }
    headers.host = authority;
    if (typeof headers.origin === 'string') headers.origin = `http://${authority}`;
    if (typeof headers.referer === 'string') {
      try {
        const url = new URL(headers.referer);
        headers.referer = `http://${authority}${url.pathname}${url.search}`;
      } catch {
        delete headers.referer;
      }
    }
    headers.cookie = cookie;
    // HTML 要重新注入，所以要求上游给未压缩的正文。
    if (typeof headers.accept === 'string' && headers.accept.includes('text/html')) {
      delete headers['accept-encoding'];
    }
    return headers;
  }

  function writeUpstreamResponse(upstream, req, res) {
    const headers = { ...upstream.headers };
    delete headers['set-cookie'];
    delete headers['transfer-encoding'];
    delete headers.connection;

    const type = String(headers['content-type'] ?? '');
    const injectable = req.method !== 'HEAD' && type.includes('text/html');

    if (!injectable) {
      res.writeHead(upstream.statusCode ?? 502, upstream.statusMessage, headers);
      upstream.pipe(res);
      return;
    }

    const chunks = [];
    let size = 0;
    upstream.on('data', (chunk) => {
      size += chunk.length;
      if (size > 16 * 1024 * 1024) {
        res.destroy();
        upstream.destroy();
        return;
      }
      chunks.push(chunk);
    });
    upstream.on('end', () => {
      let body = Buffer.concat(chunks).toString('utf8');
      try {
        body = transformHtml(body);
      } catch {}
      const buffer = Buffer.from(body);
      delete headers['content-length'];
      headers['content-length'] = String(buffer.length);
      res.writeHead(upstream.statusCode ?? 200, upstream.statusMessage, headers);
      res.end(buffer);
    });
  }

  async function proxy(req, res) {
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    let cookie;
    try {
      cookie = await refreshCookie();
    } catch (error) {
      log?.(`获取上游凭据失败: ${error?.message ?? error}`);
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('连接器暂时无法连接到 DSH（上游凭据不可用）');
      return;
    }

    const attempt = (value, retry) => {
      const upstream = http.request(
        {
          host: '127.0.0.1',
          port: upstreamPort,
          method: req.method,
          path: req.url,
          headers: buildHeaders(req, value),
          agent,
        },
        (response) => {
          if (response.statusCode === 401 && retry) {
            response.resume();
            void refreshCookie(true)
              .then((fresh) => attempt(fresh, false))
              .catch(() => {
                res.writeHead(502);
                res.end();
              });
            return;
          }
          writeUpstreamResponse(response, req, res);
        },
      );
      upstream.on('error', (error) => {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`上游连接失败: ${error.message}`);
      });
      req.pipe(upstream);
      req.on('aborted', () => upstream.destroy());
    };

    attempt(cookie, !hasBody);
  }

  async function handle(req, res) {
    const pathname = new URL(req.url ?? '/', 'http://phone-bridge.internal').pathname;

    if (pathname.startsWith('/__phone/')) {
      if (await handleControl(req, res, pathname)) return;
    }

    if (!authorize(req) && !(req.method === 'GET' && isPublicAsset(pathname))) {
      // 支持「配对链接」：/ ?pair=123456 直接完成配对再跳回首页，二维码和手工输码都走它。
      const url = new URL(req.url ?? '/', 'http://phone-bridge.internal');
      const code = url.searchParams.get('pair');
      if (req.method === 'GET' && code) {
        url.searchParams.delete('pair');
        const remote = req.socket.remoteAddress;
        const result = pairing.blocked(remote)
          ? { ok: false, reason: 'blocked' }
          : pairing.pair(code, req.headers['user-agent']);
        if (result.ok) {
          pairing.recordSuccess(remote);
          const cookie = result.cookie;
          res.writeHead(302, {
            location: `${url.pathname}${url.search}` || '/',
            'set-cookie': `${cookie.name}=${cookie.value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
          });
          res.end();
          log?.(`手机已配对: ${result.device.label}`);
          return;
        }
        pairing.recordFailure(remote);
      }
      const wantsHtml = String(req.headers.accept ?? '').includes('text/html');
      if (req.method === 'GET' && (wantsHtml || pathname === '/')) {
        sendHtml(res, 200, await pairingPage());
        return;
      }
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('phone not paired');
      return;
    }

    await proxy(req, res);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error) => {
      log?.(`请求处理失败: ${error?.stack ?? error}`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('phone bridge error');
      } else {
        res.destroy();
      }
    });
  });

  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  server.on('upgrade', (req, socket, head) => {
    void (async () => {
      const device = authorize(req);
      if (!device) {
        socket.end('HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\n\r\n');
        return;
      }
      let cookie;
      try {
        cookie = await refreshCookie();
      } catch {
        socket.end('HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n');
        return;
      }

      const upstream = net.connect(upstreamPort, '127.0.0.1', () => {
        const lines = [`GET ${req.url} HTTP/1.1`];
        let hasCookie = false;
        for (let index = 0; index < req.rawHeaders.length; index += 2) {
          const name = req.rawHeaders[index];
          const value = req.rawHeaders[index + 1];
          const lower = name.toLowerCase();
          if (lower === 'host') continue;
          if (lower === 'cookie') {
            lines.push(`Cookie: ${cookie}`);
            hasCookie = true;
            continue;
          }
          if (lower === 'origin') {
            lines.push(`${name}: http://${authority}`);
            continue;
          }
          if (lower === 'referer') {
            try {
              const url = new URL(value);
              lines.push(`${name}: http://${authority}${url.pathname}${url.search}`);
            } catch {}
            continue;
          }
          lines.push(`${name}: ${value}`);
        }
        if (!hasCookie) lines.push(`Cookie: ${cookie}`);
        lines.push(`Host: ${authority}`);
        upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
        if (head?.length) upstream.write(head);
        upstream.pipe(socket);
        socket.pipe(upstream);
      });

      upstream.on('error', () => {
        socket.destroy();
      });
      socket.on('error', () => {
        upstream.destroy();
      });
      upstream.on('close', () => socket.destroy());
      socket.on('close', () => upstream.destroy());
    })();
  });

  return {
    server,
    addresses: lanAddresses,
    listen: () =>
      new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, bind ?? '0.0.0.0');
      }),
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        sockets.clear();
        agent.destroy();
        server.close(() => resolve());
      }),
  };
}
