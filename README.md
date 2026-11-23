# DSH Phone Bridge（手机桥）

让同一局域网里的手机，用浏览器直接操控电脑上的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）。

不用公网、不用账号、手机端不用装任何东西——打开一个网址，就是 DSH 的完整界面。

> English summary at the bottom.

## 它能做什么

- **手机浏览器直连**：手机上打开 `http://<电脑IP>:4870`，配对后就是完整的 DSH 界面，可以发指令、看实时输出、审批工具调用、回答提问、停止、开新会话、切模型。
- **扫码配对**：电脑配对页显示二维码，手机扫一下就连上，不用手输地址和码。
- **多台电脑**：每台装一份，手机上一个页面列出同网段的所有 DSH 电脑，点一下切换。
- **只显示真实网卡**：自动排除 VPN（GlobalProtect/PANGP）、Hyper-V/WSL、TAP、蓝牙等虚拟网卡。
- **断线自愈**：电脑端重启后端口被占用会自动重试，不会静默失败。

## 工作原理

DSH 桌面端只监听 `127.0.0.1`，而且每个进程有一个随机启动 token，浏览器必须先用它换一张签名 cookie。

本插件在 DSH 进程内做了三件事：

1. 在局域网端口（默认 `4870`）启动一个反向代理；
2. 用进程内的 launch token 换出合法 cookie，代手机访问本机 DSH（不绕过任何检查，cookie 仍由 DSH 签发和校验）；
3. 加一道自己的配对门槛，并把 HTML 响应注入少量手机端样式。

所以手机看到的是**同一个 DSH、同一批会话**，不是第二个实例。

## 环境要求

- Windows（安装脚本是 PowerShell；插件本身是 Node 代码，其他系统可手动安装）；
- 已安装 DSH 桌面端；
- 手机与电脑在**同一个局域网**。

## 安装

1. 下载 [Releases](../../releases) 里的 `dsh-phone-bridge-*.zip`，解压到任意目录；
2. **完全退出** DSH 桌面端（托盘图标右键退出）；
3. 双击 `安装手机桥.cmd`（或 `powershell -ExecutionPolicy Bypass -File .\install.ps1`）；
4. 重新打开 DSH；
5. 浏览器打开 `http://127.0.0.1:4870/__phone/desktop`，页面上有配对码和二维码。

安装脚本会：把插件复制到 `%LOCALAPPDATA%\dsh-phone-bridge`、备份并修改 profile 的 `package.json`、用 DSH 自带的 pnpm 安装（不联网、不需要管理员），失败自动回滚。

## 使用

- **手机浏览器**：打开配对页上显示的 `http://<电脑IP>:4870`，输入 6 位配对码，或直接扫二维码；
- **多台电脑**：手机收藏任意一台的 `http://<IP>:4870/__phone/machines`，就是「我的电脑」列表；
- 配对码 5 分钟有效、用一次作废。

## 配置

在 DSH profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: phone-bridge
  name: dsh-phone-bridge
  config:
    port: 4870          # 局域网端口
    bind: 0.0.0.0       # 监听地址
    enabled: true
```

## 安全模型（请读完）

- 配对后的手机持有**所有者级权限**：能批准工具调用、改文件、开终端，等同于你本人在电脑浏览器上操作。只配对你的手机；手机丢了就在配对页点「断开」。
- 配对码 5 分钟有效、用一次作废；同一 IP 连续输错会短暂锁定。
- 「看配对码 / 断开设备」这类管理接口只接受来自 `127.0.0.1` 的请求。
- 静态资源（JS/CSS/manifest）不设门槛——与 DSH 自身策略一致，它们不含会话内容。
- 传输是**明文 HTTP**。局域网内能抓包的人可以看到流量，但看不到 DSH cookie（cookie 由插件代持，不下发到手机）。**不要在不可信的公共 Wi-Fi 上开放这个端口。**

## 卸载

1. 完全退出 DSH；
2. 双击 `卸载手机桥.cmd`；
3. 重新打开 DSH。

配对记录保存在 `%USERPROFILE%\.dsh\phone-bridge\`，默认保留；加 `-PurgeState` 一起删除。

## 已知限制

- 只能内网：手机走 4G 或公司网、电脑在另一个网络时连不通；
- 电脑睡眠时连不上；
- 电脑 IP 变化（DHCP）后，手机上的旧地址会失效，回配对页看新地址；
- 没有后台推送：页面切后台后收不到「干完了」提醒。

## 配套手机 App

HarmonyOS 原生壳（DSH 掌中）正在开发中，提供图标、扫码、电脑列表、横屏等功能。它只是这个网页的外壳，核心仍是本插件。

## 开发

```
phone-bridge/
  lib/index.js     # 插件入口：取 cookie、起服务、挂路由
  lib/server.js    # 局域网 HTTP + 反向代理 + 配对门槛
  lib/pairing.js   # 配对码、设备 cookie、状态落盘
  lib/pages.js     # 配对页与手机端注入
  lib/qr.js        # 二维码生成
  lib/scan.js      # 同网段扫描
  lib/adapters.js  # 真实网卡识别
```

零第三方依赖（二维码编码器已内置并保留署名），没有构建步骤，改完重启 DSH 生效。

## 许可

MIT，见 [LICENSE](LICENSE)。第三方组件见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

---

## English

**DSH Phone Bridge** lets a phone on the same LAN control [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) running on a Windows PC, through a plain browser.

The plugin runs inside the DSH host process, starts a reverse proxy on port `4870`, mints a valid browser cookie from the in-process launch token (DSH still issues and verifies the cookie), and adds a pairing gate of its own. The phone sees the same DSH instance and the same sessions.

- Install: unzip a release, quit DSH, run `安装手机桥.cmd`, restart DSH, open `http://127.0.0.1:4870/__phone/desktop`.
- Pair: scan the QR code or type the 6-digit code on the phone (same LAN).
- Security: a paired phone has owner-level access. LAN only; plain HTTP; admin endpoints are loopback-only.

MIT licensed.
