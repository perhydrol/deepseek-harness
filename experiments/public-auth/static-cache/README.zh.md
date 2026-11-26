# dsh-static-cache

[English](README.md) | 中文

以树外 profile 插件安装的 DSH Web 静态资源浏览器缓存。不改动部署的鉴权：Service Worker 只保存已登录页面用会话 Cookie 实际取回的字节。

写入缓存要求认证代理提供的 `X-DSH-Upstream-Cache-Control` 声明正数 `max-age`，或者声明 `no-cache` / `max-age=0` 且响应携带 `ETag` 或 `Last-Modified`；缺失策略和 `no-store` 都会被拒绝。`no-cache` 条目会被保存，但每次使用前都重新校验；`immutable` 条目在新鲜期内直接复用，不做资源校验。每次缓存命中仍然通过网络请求 `/_auth/session` 校验会话。注销请求即使不发生页面导航也会清理缓存。Worker 激活时删除旧缓存代际。默认 `prefixes` 已包含字体替换插件的 `/font-replacement/`：哈希命名的 WOFF2 是不可变的，声明 `no-cache` 的样式表则通过 ETag 重新校验。

## 缓存范围

| 路径 | 是否缓存 | 原因 |
|---|---|---|
| `/assets/*`（带 hash 的 JS、CSS、字体、图片） | 是，需要重新校验 | DSH 返回 `no-cache` 和 ETag |
| `/plugins/??...&rev=`（combo 包、chunk、包内资源） | 是 | DSH 用版本号寻址，并声明 `immutable` |
| `/font-replacement/*.woff2` | 是 | 哈希命名，声明 `immutable` |
| `/font-replacement/fonts.css` | 是，需要重新校验 | 声明 `no-cache`，带 ETag |
| `/`（index） | 否 | 带有 per-peer 启动注入 |
| `/api/*` | 否 | 与会话相关的响应 |
| `/plugins/events`（SSE） | 否 | 长连接 |
| `/_auth/*`、`/connect` | 否 | 鉴权 |

`no-cache` 条目只有在源站返回 304 后才算命中；返回 200 时会替换已保存的字节。`immutable` 条目在 `max-age` 新鲜期内直接返回，过期后才重新校验。缓存去掉的是静态资源的往返，RPC 延迟不变。

## 安装（容器部署）

镜像内已经带有构建好的 `/opt/static-cache` 插件。每个 profile 启用一次：

```sh
docker compose --env-file server.env exec harness sh /opt/static-cache/enable.sh
docker compose --env-file server.env restart harness
```

脚本执行 profile 需要的两步：

1. 把构建产物（`package.json` 和 `dist/`）复制到 `<profile>/node_modules/@perhydrol/dsh-static-cache`，并写入 `<profile>/package.json` 的 `dependencies`；
2. 如果 profile 的 `cordis.patch.yml` 里还没有对应行，追加一条 `insert` 行。

两步都是幂等的。profile 位于 `data` 卷，容器重建后仍然有效；从旧卷恢复后重新运行脚本即可。源码位于 `src/`，使用 TypeScript 编写；镜像构建会编译到 `dist/`，并在复制前运行该包的测试。

## 配置

行的 `config` 支持下列字段，全部可选。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `route` | `/__dsh-static-cache/sw.js` | 提供 worker 脚本的路径 |
| `scope` | `/` | worker 作用域；每个前缀都必须位于其中 |
| `prefixes` | `["/assets/", "/plugins/", "/font-replacement/"]` | 可缓存路径前缀 |
| `exclude` | `["/plugins/events"]` | 始终走网络的确切路径 |
| `prime` | `true` | 页面加载后抓取并保存当前页资源 |
| `concurrency` | `4` | 并行预取请求数 |
| `maxCacheBytes` | 64 MiB | 整个缓存上限；最久未写入的条目先淘汰 |
| `maxEntryBytes` | 32 MiB | 超过该体积的响应只转发、不保存 |
| `graceMinutes` | `10` | 部署后上一代 build 的条目保留时长 |
| `maxAgeDays` | `30` | 超过该天数未再写入或重新校验的条目会被删除 |
| `revalidate` | `true` | 对携带 ETag 或 Last-Modified 的过期条目发起重新校验 |

`revalidate: false` 会关闭校验器处理：`no-cache` 和 `max-age=0` 的响应不会被保存，旧部署留下的过期条目会退化为完整下载。正数 `max-age` 的响应仍然可以缓存。

配置行示例：

```yaml
- insert:
    - id: static-cache
      name: '@perhydrol/dsh-static-cache'
      config:
        route: /__dsh-static-cache/sw.js
        prime: true
        maxCacheBytes: 134217728
```

## 失效机制

页面加载后把客户端图版本（`__DSH_BOOT__.rev`）和自身的 `performance.timeOrigin` 发送给 worker：

* 版本变化时，以页面开始时间作为新一代的起点；
* 在该时间之前写入的条目属于上一代 build，在 `graceMinutes` 之后删除，因此部署不会打断仍在运行旧 build 的标签页；
* 加载当前页面期间写入的条目会保留，所以部署后的第一次加载不会重复下载；
* 导航到 `/_auth/login`（登出或会话过期）会删除整个缓存；
* `maxAgeDays` 与 `maxCacheBytes` 分别约束条目的保留时长与总量；
* 304 重新校验会刷新条目的 `storedAt`，因此活跃使用的 `no-cache` 条目不会因为年龄被删除。

`maxAgeDays` 仍然是本地保留上限。304 会刷新 `storedAt`；新鲜期内的 `immutable` 命中不会刷新，因此只靠直接命中使用的条目仍可能在该天数后被删除。

稳定路径的包资源（`/plugins/<pkg>/assets/*`）依赖客户端图版本，而版本哈希的是 bundle 产物而不是这些文件本身。只改资源、所有 bundle 字节不变时，旧资源可能保留到 `maxAgeDays`；这类更新需要重建 bundle，或调低该上限。

## 验证

在 DevTools 中两次打开同一个已登录页面：

* 第二次加载时，`/plugins/*` 显示 `(ServiceWorker)`，资源传输字节为 0；
* `/assets/*` 和 `/font-replacement/fonts.css` 显示 304 响应和 `(ServiceWorker)`，响应体来自 Cache Storage；
* `/api/*` 仍然出现在网络面板中；
* `await __DSH_STATIC_CACHE__.stats()` 返回 `entries`、`bytes`、`rev`、`hits`、`misses`、`stored`、`evicted`、`reconciled`、`revalidated`、`dropped`、`lastPrune`；其中 `entries`/`bytes` 是元数据对账后仍在缓存中的条目；
* 新鲜期内的 `immutable` 条目不发送 `If-None-Match`，`no-cache` 条目会发送；
* 注册失败会在控制台输出一条 `console.warn`，不再静默；
* 登出并回到登录页后，`caches.keys()` 为空。

启用插件后的第一次已登录加载会额外下载一次资源以填充缓存；之后一直复用，直到部署发生变化。`no-cache` 资源每次加载仍需要一次条件请求。

## 卸载

从 profile 的 `cordis.patch.yml` 删除 `static-cache` 行并重启。worker 不再注册；浏览器里的缓存字节会在访问登录页或清除站点数据时消失。插件仍启用时，可以调用 `await __DSH_STATIC_CACHE__.purge()` 立即清空。

## 安全说明

* worker 路由位于部署的反向代理之后，和 DSH 其他路径一样需要会话。
* 只保存版本化的静态字节。worker 拒绝 HTML、API 响应、SSE、重定向响应、Range 请求以及任何带 `Set-Cookie` 的响应，缓存中不包含会话状态。
* `no-cache` 条目不会在没有网络校验的情况下被复用。`immutable` 条目在新鲜期内跳过资源校验，但仍然需要 `/_auth/session` 探测。
* 缓存条目位于浏览器 profile 内；同一设备上的未登录用户无法打开应用，且下一次访问登录页会清空缓存。

## 限制

* `no-cache` 条目每次使用都需要一次条件往返；内容变化后的第一次使用会下载完整响应。
* 如果代理剥掉 `ETag` 或 `Last-Modified`，`no-cache` 响应不会被保存，因为它们无法校验。
* `maxAgeDays` 可能早于源站的 `max-age` 删除 `immutable` 条目，因为保留期是本地策略。
* RPC 调用的本地延迟不变。
* 缓存按浏览器 profile 和 origin 隔离；无痕会话从空缓存开始。
* Service Worker 需要 HTTPS 或回环地址。
* 浏览器存储压力或"清除站点数据"会清空缓存；下一次已登录加载会重新填充。

## 测试

```sh
cd experiments/public-auth/static-cache && npm test
```

测试脚本先把 TypeScript 源码编译到 `dist/`，再在 VM 中用假的 Cache Storage 执行真实 worker 源码，覆盖代际切换、宽限期清理、登出清理、预热、淘汰、流式响应、ETag 重新校验、`immutable` 的 reload 行为以及重新校验失败。
