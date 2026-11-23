# DSH 手机桥（dsh-phone-bridge）

让同一局域网里的手机，用浏览器直接指挥电脑上的 DeepSeek Harness（DSH）。
不需要公网、不需要账号、不装 App。

## 一、它能做什么

- 只展示真实局域网网卡：VPN（如 GlobalProtect）、Hyper-V/WSL、TAP、蓝牙等虚拟网卡会被自动排除。
- 手机打开一个网页，就是 DSH 的完整界面：发指令、看进度、审批工具调用、回答提问、停止、新会话、切模型，全都有。
- 首次配对输一次 6 位码，之后这台手机长期免输。
- 多台电脑各装一份后，手机上一个「我的电脑」页面能看到局域网里所有装了本插件的机器，点一下切换。
- 只监听内网；「看配对码 / 断开设备」这类管理接口只接受本机访问。

## 二、它是怎么工作的

DSH 桌面端本身只监听 `127.0.0.1`，而且每个进程有一个启动 token，浏览器必须先换一张签名 cookie 才能访问。
本插件在进程内做了三件事：

1. 在局域网端口（默认 `4870`）起一个反向代理；
2. 用进程内的 launch token 换出合法 cookie，代手机访问本机 DSH；
3. 加一道自己的配对门槛，并把 DSH 的 HTML 响应注入一点手机端样式。

所以手机看到的是**同一个 DSH、同一批会话**，不是另一个实例。

## 三、安装（每台电脑一次）

用打包好的 zip（`dist/dsh-phone-bridge-*.zip`）：

1. 解压到那台电脑上任意位置；
2. **完全退出** DSH 桌面端（托盘图标右键退出）；
3. 双击 `安装手机桥.cmd`（或 `install.ps1` 右键「使用 PowerShell 运行」）；
   若被策略拦截：`powershell -ExecutionPolicy Bypass -File .\install.ps1`
4. 看到「安装完成」后重新打开 DSH；
5. 浏览器打开 `http://127.0.0.1:4870/__phone/desktop`。

脚本会：把插件复制到 `%LOCALAPPDATA%\dsh-phone-bridge`、备份并修改 `%USERPROFILE%\.dsh\profiles\desktop\package.json`、用 DSH 自带的 pnpm 安装（不联网、不需要管理员），失败自动回滚。安装完可以删掉 U 盘里那份。

> 已经装过时双击 `安装手机桥.cmd` 会先问「[U] 卸载 / [R] 重装 / 回车退出」，不会直接覆盖。

> 改 profile 的依赖不会热加载，必须重启一次 DSH。

### 手动安装（等价，出问题时对照用）

```powershell
cd "$env:USERPROFILE\.dsh\profiles\desktop"
# dependencies 里加：  "dsh-phone-bridge": "link:<插件目录，正斜杠>"
# dsh.profile.bundles 末尾加： "dsh-phone-bridge"
pnpm install --ignore-scripts
```

启动日志里会出现：

```
[phone-bridge] 手机访问: http://192.168.x.x:4870
[phone-bridge] 电脑上配对: http://127.0.0.1:<Web 端口>/phone-bridge
```

## 四、第一次配对

1. 电脑浏览器打开 **`http://127.0.0.1:4870/__phone/desktop`**（这个端口固定，不受 DSH 每次启动换端口影响）。
2. 页面上会显示 6 位配对码和手机可用的地址。
3. 手机连同一个 Wi-Fi，打开该地址，输入配对码。
4. 配对成功后手机会跳进 DSH 界面；这台设备以后不用再输。

想少打一次字：配对页上直接有**二维码**（内容是 `http://<地址>/?pair=<配对码>`），用华为相机或「DSH 遥控」App 扫一下即可，不需要手输。二维码里的码和页面上的是同一个，5 分钟有效、用一次作废。

## 五、多台电脑

每台电脑各装一次（第三节）。装完重启后：

- 手机收藏任意一台的 **`http://<那台IP>:4870/__phone/machines`**，就是「我的电脑」列表；
- 页面会扫描同网段、列出所有装了手机桥的机器（机器名取 Windows 主机名），点一下直接进；
- **每台第一次都要配对一次**（浏览器的 cookie 按主机隔离），配对码在该台电脑上打开 `/__phone/desktop` 查看；
- 扫描不到的机器（路由器开了客户端隔离、跨网段）可以在列表页「手动添加」`IP` 或 `IP:端口`。

扫描是在服务器端做的：只探本机所在网段、只探本插件端口，结果缓存 8 秒，避免被当成通用端口扫描器。

## 六、配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖：

```yaml
- id: phone-bridge
  name: dsh-phone-bridge
  config:
    port: 4870          # 局域网端口
    bind: 0.0.0.0       # 监听地址；改成某个具体 IP 可限制只用那张网卡
```

`enabled: false` 可临时关闭。

## 七、安全模型（请读完）

- 配对后的手机持有的是**所有者级权限**：它能做的事和你在电脑浏览器里做的一样，包括批准工具调用、改文件、开终端。
  所以只配对你自己的手机；手机丢了，在电脑的配对页点「断开」。
- 配对码 5 分钟有效、用一次作废；同一 IP 连续输错会短暂锁定。
- 管理接口（看码、断开设备）只接受来自 `127.0.0.1` 的请求。
- 静态资源（JS/CSS/manifest）不设门槛，和 DSH 自己的策略一致；它们不含你的会话内容。
- 传输是明文 HTTP。局域网里能抓包的人可以看到流量，但看不到 DSH 的 cookie（cookie 是插件代持的，不下发到手机）。**不要在不可信的公共 Wi-Fi 上开这个端口。**

## 八、已知限制

- **只能内网**：手机走 4G 或公司网、电脑在家里的 Wi-Fi 时，物理上连不通。
- **没有后台推送**：鸿蒙浏览器会冻结后台页面，内网也没有推送通道。干完活只能在页面开着时响铃/震动；切回页面会自动补进度。
- **语音**：不使用网页麦克风（HTTP 页面下被浏览器禁用）。用鸿蒙输入法自带的语音输入即可。
- **审批可能和电脑抢**：手机和电脑是同一个所有者身份，同一时刻两边都能回答审批，先答的生效。
- **电脑睡眠时连不上**；唤醒后需要重新打开页面。
- 电脑 IP 变了（DHCP），手机上的旧地址会失效：回配对页看新地址即可。

## 九、卸载

安装和卸载共用同一个脚本，双击对应入口即可：

- 安装：双击 `安装手机桥.cmd`
- 卸载：双击 `卸载手机桥.cmd`
- 命令行：`powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall`

卸载会从 profile 移除依赖与 bundle、跑一次 pnpm 摘掉链接、删除 `%LOCALAPPDATA%\dsh-phone-bridge`；**保留**配对记录（`$DSH_HOME/phone-bridge`）。要连配对记录一起删：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall -PurgeState
```

不带参数运行 `install.ps1` 时，如果检测到**已安装**，会问「[U] 卸载 / [R] 重装 / 回车退出」。

> 如果你直接删掉了插件源码目录却没先卸载，profile 里的 `link:` 会指向不存在的路径，下次 DSH 可能起不来。正确顺序是先卸载再删目录。

## 十、开发者说明

插件不依赖任何第三方包，只用 Node 内置模块；没有构建步骤，改完 `lib/*.js` 重启 DSH 即生效。

- `lib/index.js`：插件入口。等到 `webServer` 监听后用 `ctx.connection.authenticatedUrl()` 换 cookie，起局域网服务，并在 DSH 自己的 Web 服务上挂 `/phone-bridge` 入口。
- `lib/server.js`：局域网 HTTP 服务与反向代理。把 Host / Origin / Referer 改写成 `127.0.0.1:<上游端口>`、注入认证 cookie，HTML 响应做手机端注入；WebSocket 升级按原始 socket 转发。
- `lib/pairing.js`：6 位一次性配对码、设备 cookie（HMAC 签名）、状态落盘与暴力破解锁定。
- `lib/pages.js`：桌面配对页、手机配对页、注入的样式与脚本。

## 十一、排查

配对页上的「与 DSH 的连接正常」是实时的健康检查：

| 现象 | 原因与处理 |
|---|---|
| 配对页打不开（本机 `127.0.0.1:4870`） | 插件没加载：确认 profile 的 `package.json` 里依赖和 `dsh.profile.bundles` 都有 `dsh-phone-bridge`，然后重启 DSH |
| 配对页打开但显示「连接异常」 | 取不到 DSH 的认证 cookie，通常是版本不匹配（`authenticatedUrl` 不存在）或 Web 服务尚未监听，看 DSH 启动日志里的 `[phone-bridge]` 行 |
| 手机打不开地址 | 不在同一网段；或 Windows 防火墙拦了。DSH 的可执行文件已有「专用/公用网络」入站放行规则，通常不用额外加 |
| 手机提示配对码不对 | 码 5 分钟过期、用一次作废；在电脑上刷新即可 |
| 端口 4870 被占用 | 0.3.1 起会自动每 2 秒重试，最多 60 秒（重启时旧进程没退干净很常见）；一直失败说明有第二个 DSH 在跑。启动结果写在 `$DSH_HOME\phone-bridge\status.json` |

## 十二、目录结构

```
phone-bridge/
  package.json          # dsh.bundle.patch 声明，告诉 DSH 这是插件包
  cordis.patch.yml      # 往 DSH 插件树里插入自己
  lib/index.js          # 入口：取 cookie、起服务、挂 /phone-bridge
  lib/server.js         # 局域网 HTTP + 反向代理 + 配对门槛
  lib/pairing.js        # 配对码与设备 cookie
  lib/pages.js          # 配对页与手机端注入
```

