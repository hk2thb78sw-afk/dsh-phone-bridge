// 手机桥：让同一局域网里的手机通过浏览器指挥本机的 DSH Agent。
//
// 做法（Phase A）：在局域网另起一个带配对门槛的 HTTP 服务，把请求反向代理到本机
// 的 DSH Web 服务，并复用进程内的 launch token 换出合法 cookie。手机上看到的就是
// 完整的 DSH 界面，审批、提问、停止、新会话全都在。
import { homedir } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Pairing } from './pairing.js';
import { createLanServer } from './server.js';
import { listAddresses } from './adapters.js';
import { injectMobile } from './pages.js';

export const name = 'phone-bridge';
export const inject = ['connection', 'webServer'];

const DEFAULT_PORT = 4870;

function statePath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'phone-bridge', 'state.json');
}

function isLoopback(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false;
  if (!enabled) return;

  const port = Number(config.port ?? DEFAULT_PORT);
  const bind = typeof config.bind === 'string' && config.bind ? config.bind : '0.0.0.0';
  const pairing = new Pairing(statePath());
  const log = (message) => console.log(`[phone-bridge] ${message}`);

  /** 启动结果写一份到磁盘，端口没起来时可以据此判断原因。 */
  const writeStatus = (value) => {
    try {
      const file = join(dirname(statePath()), 'status.json');
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ at: Date.now(), upstreamPort: ctx.webServer.port, ...value }, null, 2));
    } catch {}
  };

  let lan;
  let closed = false;
  let starting;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /** 等 Web 服务真正监听：桌面端里插件可能比监听器先就绪。 */
  const waitForUpstreamPort = async () => {
    for (let attempt = 0; attempt < 60; attempt += 1) {
      if (closed) throw new Error('插件已卸载');
      const value = ctx.webServer.port;
      if (Number.isSafeInteger(value) && value > 0) return value;
      await sleep(250);
    }
    throw new Error('上游 Web 服务迟迟没有监听');
  };

  /**
   * 用进程内的 launch token 换一份上游 cookie。
   * DSH 的浏览器认证是「token 换 cookie」，这里是同一个流程的进程内版本，
   * 不绕过任何检查：cookie 仍然由上游签发和校验。
   */
  const mintCookie = async () => {
    const upstreamPort = await waitForUpstreamPort();
    const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${upstreamPort}/`);
    const response = await fetch(url, { redirect: 'manual' });
    const header = response.headers.getSetCookie?.() ?? [response.headers.get('set-cookie') ?? ''];
    const auth = header.find((value) => value.startsWith('dsh-auth-'));
    if (!auth) throw new Error(`未取得认证 cookie（HTTP ${response.status}）`);
    return auth.split(';')[0];
  };

  const start = async () => {
    if (closed) return;
    const upstreamPort = await waitForUpstreamPort();

    // 重启时旧进程可能还没释放端口：重试到 60 秒，而不是直接放弃。
    for (let attempt = 0; attempt < 30; attempt += 1) {
      if (closed) return;
      const server = createLanServer({
        port,
        bind,
        upstreamPort,
        pairing,
        getCookie: mintCookie,
        transformHtml: injectMobile,
        log,
        resolveAddresses: () => listAddresses({ file: join(dirname(statePath()), 'adapters.json'), log }),
      });
      try {
        await server.listen();
      } catch (error) {
        await server.close().catch(() => {});
        if (error?.code !== 'EADDRINUSE') {
          log(`启动失败: ${error?.message ?? error}`);
          writeStatus({ error: String(error?.message ?? error) });
          return;
        }
        if (attempt === 0) log(`端口 ${port} 被占用（可能是上一次的 DSH 还没退干净），每 2 秒重试…`);
        await sleep(2000);
        continue;
      }
      if (closed) {
        await server.close();
        return;
      }
      lan = server;
      const urls = await server.addresses();
      for (const address of urls) log(`手机访问: ${address}`);
      log(`电脑上配对: http://127.0.0.1:${upstreamPort}/__phone/bridge`);
      writeStatus({ port, addresses: urls });
      return;
    }
    log(`端口 ${port} 一直没释放，手机桥没有启动；请确认没有第二个 DSH 在跑`);
    writeStatus({ error: `port ${port} in use` });
  };

  starting = start().catch((error) => log(`初始化失败: ${error?.message ?? error}`));

  ctx.effect?.(() => () => {
    closed = true;
    void starting?.then(() => lan?.close());
  });

  // 在 DSH 自己的 Web 服务上挂一个入口，电脑浏览器打开即可看配对码。
  try {
    const disposeRoute = ctx.webServer.register({
      kind: 'exact',
      path: '/phone-bridge',
      handler: (req, res) => {
        if (!isLoopback(req.socket.remoteAddress)) {
          res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('phone-bridge: 只允许本机访问');
          return;
        }
        res.writeHead(302, { location: `http://127.0.0.1:${port}/__phone/desktop` });
        res.end();
      },
    });
    ctx.effect?.(() => () => disposeRoute?.());
  } catch (error) {
    log(`配对入口注册失败: ${error?.message ?? error}`);
  }
}
