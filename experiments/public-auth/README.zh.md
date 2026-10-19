# 单用户认证代理实验

[English](README.md)

独立 TypeScript 项目，不加入 DSH 工作区，可以整目录迁移到独立仓库。[Better Auth](https://better-auth.com/docs) 负责密码散列、持久会话、签名 Cookie、CSRF 防护及限流；[Fastify HTTP Proxy](https://github.com/fastify/fastify-http-proxy) 负责 HTTP 流式转发和 WebSocket 转发。不修改 DSH 源码或认证机制：代理使用私有的 DSH 启动链接换取内部 Cookie，浏览器仅获得独立会话凭证。代理不会向上游传递浏览器凭证或客户端声明的转发信息。

要求 Node 24.19 及以上、pnpm 11.25.0。在本目录执行：

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
node dist/main.js init --state ./state
```

初始化会显示一次随机生成的管理员密码。也可通过 `--password-file FILE` 提供包含 12 至 128 个字符的密码文件。签名密钥和 Better Auth SQLite 数据库必须保密并持久保存，初始化不会覆盖已有管理员。公网不挂载注册或其他账户管理接口。Windows 权限继承父目录，请使用自己的私有用户目录。

通过正常的 `dsh web --no-open` 单独启动 DSH，监听明确的内网或回环地址。将其包含 token 的完整根路径启动链接放入 `launch-url.txt`。该文件是服务端凭据。DSH 重启后应更新该文件；内部 Cookie 在签名密钥和有效期均有效时仍可使用。

```sh
node dist/main.js serve --origin http://127.0.0.1:8080 --launch-url-file ./launch-url.txt --state ./state
```

浏览器访问 `/` 会跳转到 `/_auth/login`。HttpOnly、SameSite=Strict 的持久 Cookie 默认有效 30 天，可通过 `--session-days` 调整，不采用滑动续期。HTTPS 来源额外设置 Secure 和 `__Secure-` 前缀。浏览器 JavaScript 不会将凭证写入 localStorage。带同源 Origin 请求头的 `POST /_auth/logout` 撤销该会话并断开其 WebSocket；会话到期也会断开其 WebSocket。`GET /_auth/session` 检查登录状态。

Better Auth 按连接 IP 限制登录尝试，默认每 60 秒五次，可用 `--login-attempts`、`--login-window-seconds` 调整，并在 SQLite 中持久保存计数。当前置 TLS 代理通过回环地址连接时，客户端共享该代理的限流预算；传入的转发请求头不能覆盖它。上游修改请求绝不自动重试。收到上游 401 后，代理为下一次请求更新凭据，不重放失败请求。操作失败时结果可能未知，请检查 DSH 后再决定是否重试修改。

## Linux 与 Docker

```sh
docker build -t dsh-public-auth .
```

Linux 上若 DSH 监听宿主机回环地址，可使用 host 网络，将本项目私有状态目录读写挂载、启动链接文件只读挂载，并传入相同的 `serve` 参数。镜像使用非特权 `node` 用户，挂载的状态目录必须允许该用户写入。代理默认仍监听 `127.0.0.1`；前置 HTTPS 反向代理应保留外部 Host 和 WebSocket 升级请求。设置 `--origin https://YOUR_DOMAIN`，确保代理 HTTP 监听端口和 DSH 均不能被公网直连。公网 HTTP 来源会导致启动失败。代理忽略 TLS 转发头，由显式配置的公网来源决定 Secure Cookie。

这是单用户实验，不提供用户隔离。能控制 DSH 代理执行的人，可能根据服务器的进程或容器权限访问相邻服务或凭据。认证代理不约束代理工具执行权限。测试使用受控上游服务；真实 DSH 和 Linux 容器验证需要分别报告。
