# 单容器部署

[English](README.md) | 中文

镜像 `ghcr.io/perhydrol/dsh-used-by-self` 通过 npm 安装固定版本的官方包 `@deepseek-ai/dsh@0.2.1-rc.2`，不编译或修改 DSH 源码。独立 TypeScript 认证代理通过 pnpm 和锁文件安装依赖、编译和测试，pnpm 仅存在于构建阶段。Supervisor 以 UID/GID `1000:1000` 管理两个进程及其进程组，负责重启与关闭；它不提供进程间权限隔离。

## 首次部署

需要 Linux Docker、Compose 插件，以及能访问宿主机回环地址的现有 HTTPS 反向代理。从本目录执行以下命令。复制配置后修改域名；`server.env` 包含部署配置和可选 API Key，不要提交或公开。私有 GHCR 镜像需先登录 registry。

```sh
cp server.env.example server.env
chmod 600 server.env
docker compose --env-file server.env pull
docker compose --env-file server.env run --rm --no-deps --entrypoint node harness /opt/auth/dist/main.js init --state /var/lib/dsh-auth
docker compose --env-file server.env up -d
docker compose --env-file server.env ps
```

初始化显示一次随机管理员密码，请保存到密码管理器。已有管理员时不要重复初始化。启动后 DSH 的私有链接自动写入容器内 `/run/dsh/launch-url`，代理等待 DSH 就绪后交换内部 Cookie；标准输出与标准错误中的 URL token 会被遮蔽。DSH 重启会替换此文件。官方 CLI 启动输出格式改变时，就绪检查失败，需要适配后才能提供服务。

将 [Nginx 示例](nginx.conf.example) 加入现有 TLS 站点，保留外部 Host、Origin 和 WebSocket 升级，禁用缓存与缓冲。此示例假设 Nginx 运行在宿主机或使用 host 网络；普通 bridge 网络的 Nginx 容器不能通过自己的 `127.0.0.1` 访问宿主机。浏览器访问 `PUBLIC_ORIGIN` 登录。公网必须使用 HTTPS；Cloudflare 等前置服务也不得缓存认证页面和 API 响应。

Compose 只将认证代理发布到宿主机 `127.0.0.1:3080`；DSH 只监听容器内 `127.0.0.1:3081`，没有直接发布端口。默认目录为 `/home/node`，HOME 同样指向该目录。进入 fish 使用 `docker compose --env-file server.env exec harness fish`，编辑器命令为 `nvim`；DSH 的 Bash 工具仍使用 Bash。

## Nginx 与客户端 IP

随附的 Compose 与 Nginx 配置支持 Nginx 运行在 Docker 宿主机或使用 host 网络：浏览器 → HTTPS Nginx → 宿主机 `127.0.0.1:3080` → 认证代理。保留回环端口绑定。普通 bridge 网络中的 Nginx 容器需要单独配置通往认证代理的私有网络路径；仅修改上游主机名，不能让该容器访问宿主机的回环监听端口。不要通过将认证代理发布到公网来解决连通问题。

在 `server.env` 中设置 `TRUSTED_PROXY_IPS`，填写 Nginx 连接路径对应的认证代理连接对端地址，多个 IPv4 或 IPv6 地址用逗号分隔。默认留空，不信任任何代理；主机名、CIDR、IPv6 zone 标识和通配符会导致启动失败。对于已提供的 host 网络 Nginx 与 Docker bridge 拓扑，`TRUSTED_PROXY_IPS=172.20.0.1` 是需要在目标服务器核对的示例，不是内置默认值。填写认证代理看到的来源地址，不是浏览器 IP，也不是认证容器 IP。修改后使用下方更新命令重建服务。

在现有 Nginx `location /` 中，用 Nginx 观察到的客户端地址覆盖传入的转发头，与[随附示例](nginx.conf.example)一致：

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
```

需要单一地址时使用覆盖方式，而不是 `$proxy_add_x_forwarded_for`；后者会保留传入的转发链。参见 [Nginx 代理模块说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header)。若 Nginx 前面还有 CDN 或其他代理，连接对端就是该前置服务，直到通过 Nginx [真实 IP 模块](https://nginx.org/en/docs/http/ngx_http_realip_module.html)配置为仅从该服务的可信来源地址段接受其客户端 IP 请求头。不要允许任意来源提供替换地址。

认证代理仅接受已配置对端提供的单个有效 `X-Forwarded-For` IP，同时用于活动记录和 Better Auth 限流。可信对端缺少该头、值无效或包含地址链时返回 HTTP 400；其他对端的转发头被忽略，使用连接对端 IP。Fastify 保持 `trustProxy: false`，转发的 Host 和协议不会改变 Host 检查或已配置的公网来源。限制后端访问：能经同一可信 Docker 网关直连后端的进程也能冒充代理。保留回环端口绑定，并限制不可信的本地进程和容器。

目标服务器的部署者需要检查并重新加载 Nginx 配置，使用更新后的镜像和环境变量重建认证容器，再通过 HTTPS 验证登录和实际 WebSocket 连接。确认外部无法直连后端，并检查 Nginx 日志中的客户端地址。Better Auth 默认按 IPv6 /64 聚合登录限流，活动记录仍保留解析后的 IP。使用两个 IPv4 地址或属于不同 /64 前缀的 IPv6 地址验证登录额度独立，同时确认通过 Nginx 发送伪造的 `X-Forwarded-For` 不能切换额度。本地测试覆盖地址解析和登录限流；目标 Docker 网络与 TLS 部署仍需完成此验收。

## 持久化与配置

| 容器路径 | 用途 |
|---|---|
| `/home/node` | 默认工作目录、项目、fish 与 Neovim 配置 |
| `/var/lib/dsh` | DSH profiles、设置、凭据与会话 |
| `/var/lib/dsh-auth` | 管理员、浏览器会话和签名密钥 |
| `/var/lib/uv` | Python 虚拟环境、工具与缓存 |
| `/run/dsh` | 临时私有启动链接，重建后重新生成 |

Compose 仅在 `/data` 挂载一个命名卷。`/home/node`、`/var/lib/dsh`、`/var/lib/dsh-auth` 和 `/var/lib/uv` 分别是指向其中 `home`、`dsh`、`auth` 和 `uv` 子目录的符号链接。`TMPDIR=/data/tmp` 让默认临时环境与 uv 缓存处于同一挂载点。这些目录之间可以建立硬链接，不要用独立挂载替换符号链接。显式使用 `/tmp` 或额外挂载项目目录仍可能让 uv 回退为拷贝。`/data/tmp` 中的临时文件在容器重建后仍保留，需要应用正常清理。

命名卷由镜像初始化所有权；绑定挂载必须包含初始化后的目录树，并允许 UID/GID `1000:1000` 写入。备份前停止容器，并一并保护认证签名密钥及数据库。保留卷更新镜像，不要使用 `down -v`。用户安装的 Python 包可通过 `uv pip install` 或 `uv tool install` 保存；项目自己的 `uv run` 环境保存在项目目录。系统 Python 变化时可能需要重建默认虚拟环境。

替换使用四卷布局且数据可丢弃的部署时，先用旧 Compose 文件执行 `docker compose --env-file server.env down -v`，再替换配置和镜像。这会删除该部署所有命名卷数据，包括项目、凭据和登录会话。随后使用新 Compose 文件，按首次部署步骤重新初始化。已有数据不会自动迁移。

`PUBLIC_ORIGIN` 必填，必须为不带路径的 HTTPS 来源；本地试用允许回环 HTTP。`DEEPSEEK_API_KEY` 可选，也可在 DSH 中配置模型凭据。`SESSION_DAYS` 默认 30，`LOGIN_ATTEMPTS` 默认 5，`LOGIN_WINDOW_SECONDS` 默认 60；均需正整数，修改后重建容器。`SESSION_CACHE_SECONDS` 默认 60，需非负整数；`0` 禁用进程内已验证会话缓存。会话与错误恢复行为见[代理说明](../README.zh.md)。

## 构建和更新

```sh
docker compose --env-file server.env build --pull
docker compose --env-file server.env up -d
```

本地构建使用本目录的 Dockerfile。修改其 `DSH_VERSION` 默认值即可选择官方包版本；官方包未发布的源码功能不会进入镜像。系统工具来自 Debian，包含 fish、Neovim、Bash、Git、SSH、ripgrep、Python、Pandoc、Poppler 工具（包括 `pdftoppm`）、htop 和 Supervisor；uv 来自其官方镜像。

推送 `master` 且修改本项目或镜像 workflow 时自动构建 Linux amd64 镜像，验证成功后发布 `latest` 与 `sha-<短提交号>`；也可手动触发。固定部署版本可将 Compose 的 image 改成对应提交标签。上游 workflows 仅保留手动或复用入口；依赖 PR、Issue 事件数据的任务并不因此获得完整手动运行能力。

## 验证范围

本地 Windows 没有 Docker 引擎。镜像 workflow 负责构建、Compose 配置检查、工具检查，以及首次登录、DSH 子进程崩溃恢复、容器重启后的持久登录、日志 token 遮蔽和关闭检查；这些检查通过后才发布。探测通过 Node HTTP 接口显式设置外部 Host，不跟随重定向；失败时输出遮蔽凭据后的容器日志和健康状态。容器健康检查同时探测 DSH 和认证代理，`unhealthy` 本身不会让 Docker 自动重启容器。目标服务器的 TLS、挂载权限和模型调用仍需实际验收。
