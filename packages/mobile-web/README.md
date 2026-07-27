# JYYCode 移动网页版

这是 JYYCode 的 Safari/PWA 远程伴侣，面向 iPhone Safari，不依赖 Mac、Xcode 或 Apple Developer Program。

```sh
bun run --cwd packages/mobile-web dev
bun run --cwd packages/mobile-web test
bun run --cwd packages/mobile-web build
```

生产环境必须通过 HTTPS 提供本应用，并通过 WSS 连接中继。

## 不买域名、不租服务器的临时使用方式

Windows 电脑可以使用 Cloudflare Quick Tunnel 获得随机的
`https://*.trycloudflare.com` 地址：它把本机的网页和 WSS 中继安全地发布到
Internet，不需要公网 IP、域名、Mac 或 Apple 开发者账号。先安装 Cloudflare
官方客户端，再运行：

```powershell
winget install --id Cloudflare.cloudflared --exact
Set-ExecutionPolicy -Scope Process Bypass
.\script\start-safari-quick-tunnel.ps1 -LaunchDesktop
```

脚本会构建网页、启动本地中继、生成临时 HTTPS/WSS 地址，并在生成地址后设置
桌面端所需的中继变量。完全退出并重新打开桌面端后，在 iPhone Safari 打开脚本
显示的地址并扫码配对。保持脚本窗口打开。

这只适用于个人测试和临时远程控制：Cloudflare 明确将 Quick Tunnel 定位为开发
工具，不提供可用性保证，地址会在每次重启时变化，最多 200 个并发请求，且不
支持 SSE。JYYCode 的移动通道使用 WebSocket，因此可以工作；需要稳定地址时，
仍应使用自己的域名和命名隧道。

如果某些家庭网络的 IPv6 会重置 `api.trycloudflare.com` 连接，可附加
`-ForceTryCloudflareIPv4`。该选项需要一次 Windows 管理员确认，只会临时向
`hosts` 文件加入带 JYYCode 标记的该 API IPv4 映射；隧道关闭时自动移除，不会
改变整个系统的 IPv4/IPv6 优先级。

可从仓库根目录构建静态站点镜像：

```sh
docker build -f packages/mobile-web/Dockerfile -t jyycode-mobile-web .
docker run --rm -p 8080:8080 jyycode-mobile-web
```

请在生产环境用 HTTPS 反向代理终止 TLS；直接的 `http://` 地址无法在 iPhone Safari 中启用相机、PWA 与安全配对能力。

## 配对与安全边界

1. 将本应用部署到 HTTPS 域名，并按 `packages/relay/README.md` 部署 WSS 中继；iPhone 使用蜂窝网络时，两者都必须可公开访问。
2. 让桌面端通过 `JYYCODE_MOBILE_RELAY_URL=wss://<域名>/connect` 连接中继。
3. 在 iPhone Safari 打开移动版地址（可“添加到主屏幕”），再从桌面“设置 → 移动网页版”扫描二维码。

二维码五分钟后失效，不含本机后端地址或凭据。浏览器和桌面端使用端到端加密，中继只接收密文和最小路由元数据，且不离线缓存命令。移动版只支持任务摘要、任务操作、按需读取完整对话/代码改动；不提供终端、原始文件、密钥、MCP/供应商配置或全局设置。

Safari 打开时会实时更新。后台 Web Push 需要另行部署 HTTPS PWA 的 Web Push 发送端，因此本版本不会承诺后台通知。Safari 网站也不能在没有服务端 WebAuthn 配置时强制触发 Face ID；移动版会在冷启动、主动重新锁定及后台超过五分钟后锁定会话，请同时开启 iPhone 的设备锁定。
