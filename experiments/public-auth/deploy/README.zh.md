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

## 持久化与配置

| 容器路径 | 用途 |
|---|---|
| `/home/node` | 默认工作目录、项目、fish 与 Neovim 配置 |
| `/var/lib/dsh` | DSH profiles、设置、凭据与会话 |
| `/var/lib/dsh-auth` | 管理员、浏览器会话和签名密钥 |
| `/var/lib/uv` | Python 虚拟环境、工具与缓存 |
| `/run/dsh` | 临时私有启动链接，重建后重新生成 |

命名卷由镜像初始化所有权；绑定挂载需要提前允许 UID/GID `1000:1000` 写入。备份前停止容器，并一并保护认证签名密钥及数据库。保留卷更新镜像，不要使用 `down -v`。用户安装的 Python 包可通过 `uv pip install` 或 `uv tool install` 保存到 uv 卷；项目自己的 `uv run` 环境保存在项目目录。系统 Python 变化时可能需要重建默认虚拟环境。

`PUBLIC_ORIGIN` 必填，必须为不带路径的 HTTPS 来源；本地试用允许回环 HTTP。`DEEPSEEK_API_KEY` 可选，也可在 DSH 中配置模型凭据。`SESSION_DAYS` 默认 30，`LOGIN_ATTEMPTS` 默认 5，`LOGIN_WINDOW_SECONDS` 默认 60；均需正整数，修改后重建容器。会话与错误恢复行为见[代理说明](../README.zh.md)。

## 构建和更新

```sh
docker compose --env-file server.env build --pull
docker compose --env-file server.env up -d
```

本地构建使用本目录的 Dockerfile。修改其 `DSH_VERSION` 默认值即可选择官方包版本；官方包未发布的源码功能不会进入镜像。系统工具来自 Debian，包含 fish、Neovim、Bash、Git、SSH、ripgrep、Python 和 Supervisor；uv 来自其官方镜像。

推送 `master` 且修改本项目或镜像 workflow 时自动构建 Linux amd64 镜像，验证成功后发布 `latest` 与 `sha-<短提交号>`；也可手动触发。固定部署版本可将 Compose 的 image 改成对应提交标签。上游 workflows 仅保留手动或复用入口；依赖 PR、Issue 事件数据的任务并不因此获得完整手动运行能力。

## 验证范围

本地 Windows 没有 Docker 引擎。镜像 workflow 负责构建、Compose 配置检查、工具检查，以及首次登录、DSH 子进程崩溃恢复、容器重启后的持久登录、日志 token 遮蔽和关闭检查；这些检查通过后才发布。探测通过 Node HTTP 接口显式设置外部 Host，不跟随重定向；失败时输出遮蔽凭据后的容器日志和健康状态。容器健康检查同时探测 DSH 和认证代理，`unhealthy` 本身不会让 Docker 自动重启容器。目标服务器的 TLS、挂载权限和模型调用仍需实际验收。
