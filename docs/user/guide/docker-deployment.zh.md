# 在 Cloudflare 和 Nginx 后部署私有 Docker 镜像

[English](docker-deployment.md) | 中文

此部署通过单用户认证提供 `https://harness.example.com/`。[Dockerfile](../../../Dockerfile) 基于 Node 24 和 Debian trixie 构建工作区，包含私有 Hydrogen 包及 Linux 原生组件。它使用官方软件源。

将 Dockerfile、server profile 和 Nginx 模板中的 `harness.example.com` 替换为自己的域名，并将命令中的 `nginx-proxy` 替换为 Nginx 容器名。个人部署配置应保存在版本控制之外。

## 准备服务器

需要 Linux Docker 及 Docker Compose 插件。Harness 和 Nginx 都必须使用 host 网络，使 Nginx 能通过 `127.0.0.1:3080` 访问后端。后端仅监听回环地址。启动前确认现有 Nginx 的网络：

```sh
docker inspect nginx-proxy --format '{{.HostConfig.NetworkMode}}'
```

预期网络模式为 `host`。为 `harness.example.com` 创建启用代理的 Cloudflare DNS 记录，并确认现有源站证书覆盖此名称。

## 构建并初始化

在服务器的 fish shell 中，从仓库根目录执行：

```fish
set -gx DSH_CLIENT_COMMIT_HASH (git rev-parse HEAD)
docker compose -f deploy/docker/compose.yaml build
docker compose -f deploy/docker/compose.yaml run --rm --no-deps harness auth init --profile server
docker compose -f deploy/docker/compose.yaml up -d
```

构建参数提供真实版本信息，不将 `.git` 复制进镜像。初始化交互提示输入密码；密码不会成为镜像层或命令行参数。先初始化，再启动服务器。模型凭据可通过调用环境中的 `DEEPSEEK_API_KEY` 提供。

[compose.yaml](../../../deploy/docker/compose.yaml) 使用 [server profile](../../../deploy/docker/profile/cordis.patch.yml) 初始化命名 home 卷。该 profile 启用私有认证 bundle，仅信任回环代理，并要求代理提供单值客户端 IP 请求头。缺少凭据会阻止认证启动。

## 添加 Nginx 站点

将 [harness.example.com.conf](../../../deploy/nginx/harness.example.com.conf) 中的两个 server 块插入现有 `nginx.conf` 的 `http` 块内。保留现有 `connection_upgrade` map 和 Cloudflare IP 白名单。然后验证并重载 Nginx：

```sh
docker exec nginx-proxy nginx -t
docker exec nginx-proxy nginx -s reload
```

此站点保留 Host 和 WebSocket 升级，禁用响应缓冲与代理缓存，并使用 Cloudflare 的 `CF-Connecting-IP` 覆盖 `X-Hydrogen-Client-IP`。现有 Cloudflare 源站拉取验证及 IP 白名单仍为必要条件。无需重写 Cookie：认证提供者会根据规范 HTTPS Origin 签发 Secure Cookie。不要在 Cloudflare 强制缓存此站点的已认证页面或 API 响应。参见 [Cloudflare 请求头参考](https://developers.cloudflare.com/fundamentals/reference/http-headers/) 和 [Nginx 缓冲参考](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering)。

打开 `https://harness.example.com/`，使用初始化的密码登录，再从安全页面注册通行密钥。

## 持久化数据和维护凭据

位于 `/var/lib/dsh` 的 home 卷保存 profile、认证数据库、凭据和 Session。独立的 `/workspace` 卷保存项目文件。镜像以 UID/GID `1000:1000` 运行；自定义绑定挂载必须允许该身份写入，认证目录必须保持私有。使用认证存储支持的本地文件系统。镜像变化时，已有卷会保留其 profile。

密码维护前停止服务：

```sh
docker compose -f deploy/docker/compose.yaml stop
docker compose -f deploy/docker/compose.yaml run --rm --no-deps harness auth reset-password --profile server
docker compose -f deploy/docker/compose.yaml up -d
```

更新镜像时保留卷。此源码工作区镜像保留开发依赖，以维持私有工作区链接；它不依赖发布 Hydrogen 包。

## 验证范围

Dockerfile、YAML 和公开 CLI profile 组合已有本地检查。开发机没有 Docker 引擎，完整镜像构建、目标服务器启动及 Nginx 证书验证仍需在服务器执行。实体 Windows Hello 和 FaceID 验证还需要对应客户端设备。
