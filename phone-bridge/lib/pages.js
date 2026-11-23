// 桌面配对页、手机配对页，以及注入到 DSH 页面里的手机端样式/脚本。
// 全部是纯字符串模板，不引入任何前端依赖。

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

const BASE_STYLE = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
    background: #f6f7f9;
    color: #1b1c1f;
    padding: 24px 18px 48px;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #141517; color: #e8e9eb; }
    .card { background: #1d1f23 !important; border-color: #2c2f35 !important; }
    .muted { color: #9aa0a8 !important; }
    .addr { background: #24272c !important; }
    input { background: #24272c !important; color: #e8e9eb !important; border-color: #33373d !important; }
  }
  .wrap { max-width: 560px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: .2px; }
  .muted { color: #6b7280; font-size: 13px; line-height: 1.6; }
  .card {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 16px;
    padding: 18px;
    margin-top: 16px;
  }
  .code {
    font-size: 44px;
    font-weight: 700;
    letter-spacing: 10px;
    font-variant-numeric: tabular-nums;
    margin: 6px 0 2px;
    text-align: center;
  }
  .addr {
    display: block;
    background: #f1f3f6;
    border-radius: 10px;
    padding: 10px 12px;
    margin-top: 8px;
    font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
    font-size: 14px;
    word-break: break-all;
    color: inherit;
    text-decoration: none;
    cursor: pointer;
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
  .device { padding: 10px 0; border-top: 1px solid rgba(128,128,128,.18); font-size: 14px; }
  .device:first-child { border-top: 0; }
  .pill {
    display: inline-block;
    font-size: 12px;
    padding: 3px 9px;
    border-radius: 999px;
    background: #e8f5ec;
    color: #16794a;
  }
  button {
    font: inherit;
    border: 0;
    border-radius: 10px;
    padding: 10px 14px;
    background: #2563eb;
    color: #fff;
    cursor: pointer;
  }
  button.ghost { background: transparent; color: #b42318; padding: 6px 10px; }
  .field { display: flex; gap: 10px; margin-top: 12px; }
  .qr { display: flex; justify-content: center; padding: 12px 0 4px; }
  .qr img { width: 220px; height: 220px; border-radius: 12px; background: #fff; padding: 8px; border: 1px solid rgba(128,128,128,.2); }
  select { appearance: none; }
  input {
    flex: 1;
    font: inherit;
    font-size: 22px;
    letter-spacing: 6px;
    text-align: center;
    padding: 12px;
    border-radius: 12px;
    border: 1px solid #d1d5db;
    background: #fff;
    color: inherit;
  }
  .error { color: #b42318; font-size: 14px; margin-top: 10px; min-height: 20px; }
  .ok { color: #16794a; }
`;

function shell(title, body, extraHead = '') {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f6f7f9">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%232563eb'/%3E%3Cpath d='M18 22h12a10 10 0 0 1 0 20H18zm6 6v8h6a4 4 0 0 0 0-8z' fill='white'/%3E%3C/svg%3E">
<title>${escapeHtml(title)}</title>
<style>${BASE_STYLE}</style>
${extraHead}
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

export function machinesPage({ port }) {
  return shell(
    '我的电脑',
    `
    <h1>我的电脑</h1>
    <p class="muted">同一局域网里装了连接器的 DSH 电脑。点一台就能进去；第一次连的电脑会让你输入它屏幕上的配对码。</p>

    <div class="card">
      <div class="row"><strong>扫描结果</strong><button id="refresh">重新扫描</button></div>
      <div class="muted" id="status">正在扫描局域网…</div>
      <div id="list"></div>
    </div>

    <div class="card">
      <strong>手动添加</strong>
      <p class="muted" style="margin:6px 0 0">扫描不到时用（比如路由器开了客户端隔离）。填 IP 或 IP:端口。</p>
      <div class="field">
        <input id="address" placeholder="192.168.1.23" style="font-size:16px;letter-spacing:0;text-align:left">
        <button id="add">添加</button>
      </div>
    </div>

    <p class="muted">每台电脑第一次都要配对一次——这是浏览器的 cookie 按「主机+端口」隔离决定的，绕不过去。配对码在那台电脑上打开连接器页面就能看到。</p>
    <script>
      const MANUAL_KEY = 'dsh-phone-manual-machines';
      const listEl = document.getElementById('list');
      const statusEl = document.getElementById('status');
      const addressEl = document.getElementById('address');
      let found = [];

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      }

      function manualList() {
        try { return JSON.parse(localStorage.getItem(MANUAL_KEY) || '[]'); } catch { return []; }
      }
      function saveManual(list) { localStorage.setItem(MANUAL_KEY, JSON.stringify(list)); }

      function parseAddress(text) {
        const trimmed = String(text).trim().replace(/^https?:\\/\\//, '').replace(/\\/$/, '');
        const [address, port] = trimmed.split(':');
        return address ? { address, port: Number(port || ${port}) } : undefined;
      }

      function card(item) {
        const url = 'http://' + item.address + ':' + item.port + '/';
        const badge = item.self ? '<span class="pill">本机</span>' : (item.manual ? '<span class="pill" style="background:#eef2ff;color:#3730a3">手动</span>' : '');
        const remove = item.manual ? '<button class="ghost" data-remove="' + escapeHtml(item.address + ':' + item.port) + '">移除</button>' : '';
        return '<div class="device"><div class="row"><div><a href="' + url + '" style="color:inherit;text-decoration:none">' +
          '<div style="font-weight:600">' + escapeHtml(item.name || item.address) + '</div>' +
          '<div class="muted">' + escapeHtml(url) + '</div></a></div><div>' + badge + remove + '</div></div></div>';
      }

      function draw() {
        const manual = manualList().map((text) => {
          const parsed = parseAddress(text);
          return parsed ? { ...parsed, name: parsed.address, manual: true, self: false } : undefined;
        }).filter(Boolean);
        const known = new Set(found.map((item) => item.address + ':' + item.port));
        const extra = manual.filter((item) => !known.has(item.address + ':' + item.port));
        const all = [...found, ...extra];
        listEl.innerHTML = all.length
          ? all.map(card).join('')
          : '<p class="muted">没有扫描到其它电脑。确认那台也装了连接器并且没关。</p>';
      }

      async function render() {
        statusEl.textContent = '正在扫描局域网…';
        try {
          const response = await fetch('/__phone/scan', { cache: 'no-store' });
          const data = await response.json();
          found = data.machines || [];
          statusEl.textContent = '扫描了 ' + data.scanned + ' 个地址，找到 ' + found.length + ' 台';
        } catch (cause) {
          statusEl.textContent = '扫描失败';
        }
        draw();
      }

      document.getElementById('refresh').addEventListener('click', async () => {
        await fetch('/__phone/scan?refresh=1', { cache: 'no-store' });
        void render();
      });

      document.getElementById('add').addEventListener('click', () => {
        const parsed = parseAddress(addressEl.value);
        if (!parsed) { statusEl.textContent = '地址格式不对'; return; }
        const list = manualList();
        const text = parsed.address + ':' + parsed.port;
        if (!list.includes(text)) list.push(text);
        saveManual(list);
        addressEl.value = '';
        draw();
      });

      listEl.addEventListener('click', (event) => {
        const target = event.target?.dataset?.remove;
        if (!target) return;
        event.preventDefault();
        saveManual(manualList().filter((item) => item !== target));
        draw();
      });

      void render();
    </script>`,
  );
}

export function desktopPage({ port, upstreamPort, addresses }) {
  const list = addresses.length
    ? addresses.map((url) => `<a class="addr" data-copy="${escapeHtml(url)}">${escapeHtml(url)}</a>`).join('')
    : '<p class="muted">没有找到局域网地址，检查一下网络连接。</p>';

  return shell(
    '连接器 · 配对',
    `
    <h1>连接器</h1>
    <p class="muted">手机和电脑在同一个 Wi-Fi / 局域网时，用手机扫描或打开下面的地址，再输入配对码。</p>

    <div class="card">
      <div class="row"><strong>配对码</strong><span class="pill" id="state">服务运行中</span></div>
      <div class="code" id="code">------</div>
      <div class="muted" id="ttl">正在读取…</div>
      <div class="muted" id="upstream">正在检查与 DSH 的连接…</div>
      <div class="row" style="margin-top:12px">
        <span class="muted">端口 ${escapeHtml(port)} → 本机 ${escapeHtml(upstreamPort)}</span>
        <button id="rotate">换一个</button>
      </div>
    </div>

    <div class="card">
      <div class="row"><strong>扫码配对</strong><span class="muted">手机相机扫这个码</span></div>
      <div class="qr"><img id="qr" alt="配对二维码" width="220" height="220"></div>
      <select id="qrHost" class="addr" style="width:100%;border:0;font-family:inherit">
        ${addresses.map((url) => `<option value="${escapeHtml(url.replace(/^http:\/\//, ''))}">${escapeHtml(url)}</option>`).join('')}
      </select>
      <p class="muted" style="margin-bottom:0">扫完会自动带上配对码，不需要手输。地址有多张网卡时会列出多个，选手机实际能连上的那个。</p>
    </div>

    <div class="card">
      <strong>手机打开这个地址</strong>
      ${list}
      <p class="muted" style="margin-bottom:0">点一下地址可以复制。手机换到别的网络时，电脑的 IP 可能变化，回来这里重新看即可。手机上也可以直接收藏「<span style="font-family:ui-monospace,monospace">/__phone/machines</span>」这个列表页。</p>
    </div>

    <div class="card">
      <div class="row"><strong>已配对的设备</strong><button class="ghost" id="revoke-all">全部断开</button></div>
      <div id="devices"><p class="muted">还没有设备配对。</p></div>
    </div>

    <p class="muted">同一个局域网里的其他人拿到地址也进不来，必须输入上面的配对码。配对码 5 分钟有效，用一次就作废。</p>
    <script>
      const codeEl = document.getElementById('code');
      const ttlEl = document.getElementById('ttl');
      const stateEl = document.getElementById('state');
      const devicesEl = document.getElementById('devices');
      const upstreamEl = document.getElementById('upstream');
      let expiresAt = 0;
      let shownCode = '';
      const qrEl = document.getElementById('qr');
      const qrHostEl = document.getElementById('qrHost');

      function refreshQr() {
        const host = qrHostEl?.value || '';
        qrEl.src = '/__phone/qr.svg?host=' + encodeURIComponent(host) + '&ts=' + Date.now();
      }

      async function checkUpstream() {
        try {
          const response = await fetch('/__phone/health', { cache: 'no-store' });
          const data = await response.json();
          upstreamEl.innerHTML = data.ok
            ? '<span class="ok">●</span> 与 DSH 的连接正常'
            : '<span class="error">●</span> 连接异常：' + escapeHtml(data.error || '未知原因');
        } catch (cause) {
          upstreamEl.innerHTML = '<span class="error">●</span> 连接异常';
        }
      }

      function renderDevices(devices) {
        if (!devices.length) {
          devicesEl.innerHTML = '<p class="muted">还没有设备配对。</p>';
          return;
        }
        devicesEl.innerHTML = devices.map((device) =>
          '<div class="device row"><div><div>' + escapeHtml(device.label) + '</div>' +
          '<div class="muted">最近使用 ' + new Date(device.lastSeenAt || device.createdAt).toLocaleString() + '</div></div>' +
          '<button class="ghost" data-revoke="' + escapeHtml(device.id) + '">断开</button></div>'
        ).join('');
      }

      function escapeHtml(value) {
        return String(value).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
      }

      async function load() {
        const response = await fetch('/__phone/status', { cache: 'no-store' });
        const data = await response.json();
        codeEl.textContent = data.code;
        expiresAt = data.expiresAt;
        if (data.code !== shownCode) { shownCode = data.code; refreshQr(); }
        renderDevices(data.devices);
      }

      function tick() {
        if (!expiresAt) return;
        const left = Math.max(0, expiresAt - Date.now());
        const minutes = Math.floor(left / 60000);
        const seconds = Math.floor((left % 60000) / 1000);
        ttlEl.textContent = left > 0
          ? '有效期还剩 ' + minutes + ' 分 ' + String(seconds).padStart(2, '0') + ' 秒，用过即失效'
          : '已过期，正在换一个新的…';
        if (left <= 0) { expiresAt = 0; void load(); }
      }

      document.getElementById('rotate').addEventListener('click', async () => {
        const response = await fetch('/__phone/rotate', { method: 'POST' });
        const data = await response.json();
        codeEl.textContent = data.code;
        expiresAt = data.expiresAt;
        shownCode = data.code;
        refreshQr();
      });

      document.getElementById('revoke-all').addEventListener('click', async () => {
        const response = await fetch('/__phone/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: '*' })
        });
        const data = await response.json();
        renderDevices(data.devices);
      });

      devicesEl.addEventListener('click', async (event) => {
        const id = event.target?.dataset?.revoke;
        if (!id) return;
        const response = await fetch('/__phone/revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id })
        });
        const data = await response.json();
        renderDevices(data.devices);
      });

      document.addEventListener('click', async (event) => {
        const value = event.target?.dataset?.copy;
        if (!value) return;
        try { await navigator.clipboard.writeText(value); stateEl.textContent = '已复制'; }
        catch { stateEl.textContent = value; }
      });

      qrHostEl.addEventListener('change', refreshQr);
      void load().then(() => setInterval(tick, 1000));
      void checkUpstream();
    </script>`,
  );
}

export function pairPage({ addresses }) {
  return shell(
    '连接到电脑',
    `
    <h1>连接到电脑</h1>
    <p class="muted">在电脑上打开 <strong>连接器</strong> 页面，把上面的 6 位配对码输进来。地址：${addresses
      .map((url) => `<span class="addr" style="display:inline-block">${escapeHtml(url)}</span>`)
      .join(' ') || '—'}</p>
    <div class="card">
      <div class="field">
        <input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000">
        <button id="submit">连接</button>
      </div>
      <div class="error" id="error"></div>
      <p class="muted" style="margin:12px 0 0">配对码 5 分钟有效、用一次就作废。配对成功后这台手机长期免输。</p>
    </div>
    <p class="muted"><a href="/__phone/machines" style="color:inherit">查看局域网里的其它电脑 →</a></p>
    <script>
      const input = document.getElementById('code');
      const error = document.getElementById('error');
      const button = document.getElementById('submit');

      async function submit() {
        button.disabled = true;
        error.textContent = '';
        try {
          const response = await fetch('/__phone/pair', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ code: input.value })
          });
          const data = await response.json();
          if (!data.ok) {
            error.textContent = data.message || '配对失败';
            return;
          }
          location.replace('/');
        } catch (cause) {
          error.textContent = '连接失败，确认手机和电脑在同一个网络';
        } finally {
          button.disabled = false;
        }
      }

      button.addEventListener('click', submit);
      input.addEventListener('keydown', (event) => { if (event.key === 'Enter') submit(); });
      input.focus();
    </script>`,
  );
}

// 注入到 DSH 页面：只做手机端必须的适配，尽量不干扰桌面端。
const MOBILE_CSS = `
html { -webkit-text-size-adjust: 100%; touch-action: manipulation; }
body { overscroll-behavior-y: none; -webkit-tap-highlight-color: transparent; }
@media (max-width: 900px) {
  html[data-dsh-phone="1"] #root { min-width: 0 !important; width: 100% !important; }
  /* 手机上输入框字号小于 16px 时，聚焦会被浏览器强制放大 */
  html[data-dsh-phone="1"] textarea,
  html[data-dsh-phone="1"] input { font-size: 16px !important; }
}
`;

const MOBILE_SCRIPT = `
(() => {
  const root = document.documentElement;
  root.dataset.dshPhone = '1';
  const meta = document.querySelector('meta[name="theme-color"]') || document.createElement('meta');
  meta.setAttribute('name', 'theme-color');
  meta.setAttribute('content', matchMedia('(prefers-color-scheme: dark)').matches ? '#151517' : '#ffffff');
  document.head.appendChild(meta);
})();
`;

export function injectMobile(html) {
  const style = `<style id="dsh-phone-bridge">${MOBILE_CSS}</style>`;
  const script = `<script>${MOBILE_SCRIPT}</script>`;
  const snippet = `${style}${script}`;
  if (html.includes('</head>')) return html.replace('</head>', `${snippet}</head>`);
  return `${snippet}${html}`;
}
