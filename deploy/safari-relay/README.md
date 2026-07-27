# Safari 远程伴侣：单域名部署

此目录提供完整的公开部署组合：同一个 HTTPS 域名提供 Safari 网页和
`wss://<域名>/connect` 加密中继。Caddy 自动申请并续期 TLS 证书；中继和
网页容器不会直接暴露到公网。

## 前置条件

- 一台拥有公网 IPv4 或 IPv6 的 Linux 服务器（建议 Ubuntu 22.04+）
- 一个由你控制的域名；其 `A` / `AAAA` 记录已经指向该服务器
- 服务器开放 TCP `80`、TCP `443` 和 UDP `443`
- Docker Engine 与 Docker Compose plugin

不要将端口 8787 或 8080 暴露到互联网，也不要把任务内容、二维码或桌面
配置文件上传到服务器。

## 上线

在仓库根目录执行：

```sh
cp deploy/safari-relay/.env.example deploy/safari-relay/.env
# 编辑 .env：把 remote.example.com 改为你的真实域名
docker compose --env-file deploy/safari-relay/.env \
  -f deploy/safari-relay/docker-compose.yml up -d --build
```

验证：

```sh
curl https://你的域名/health
```

应返回中继的健康响应。然后在运行 JYYCode 桌面端的电脑上设置环境变量：

```powershell
[Environment]::SetEnvironmentVariable(
  'JYYCODE_MOBILE_RELAY_URL',
  'wss://你的域名/connect',
  'User'
)
```

完全退出并重新启动 JYYCode。iPhone 用 Safari 打开
`https://你的域名`，可选择“添加到主屏幕”；再在桌面端“设置 → 移动网页版”
展示二维码，用网页扫描即可配对。

## 运维与安全

- 升级：在仓库更新后重新执行上面的 `up -d --build`。
- 日志：`docker compose -f deploy/safari-relay/docker-compose.yml logs -f`。
  中继日志不得记录密文以外的任务信息；不要在反向代理中开启请求体日志。
- DNS 或端口未就绪时，Caddy 无法取得证书；不要为了绕过它而回退到 `http` 或
  `ws`，Safari 的相机与安全配对需要 HTTPS/WSS。
- 删除配对设备会立即使其桌面端密钥与中继路由失效。
