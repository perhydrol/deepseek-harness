# dsh-static-cache

[English](README.md) | 中文

以树外 profile 插件安装的 DSH Web 静态资源浏览器缓存。不改动部署的鉴权：Service Worker 只保存已登录页面用会话 Cookie 实际取回的字节。

写入缓存要求认证代理提供的 `X-DSH-Upstream-Cache-Control` 声明正数 `max-age`，且不含 `no-store` 或 `no-cache`；缺失策略时拒绝缓存。每次缓存命中均通过网络请求 `/_auth/session` 校验会话。注销请求即使不发生页面导航也会清理缓存。Worker 激活时删除旧缓存代际。字体替换插件需在 `prefixes` 中加入 `/font-replacement/`：哈希命名的 WOFF2 可以缓存，声明 `no-cache` 的样式表继续走网络。

## 缓存范围

| 路径 | 是否缓存 | 原因 |
|---|---|---|
| `/assets/*`（带 hash 的 JS、CSS、字体、图片） | 是 | 内容寻址，内容不变 |
| `/plugins/??...&rev=`（combo 包、chunk、包内资源） | 是 | DSH 用版本号寻址 |
| `/`（index） | 否 | 带有 per-peer 启动注入 |
| `/api/*` | 否 | 与会话相关的响应 |
| `/plugins/events`（SSE） | 否 | 长连接 |
| `/_auth/*`、`/connect` | 否 | 鉴权 |

cache-first 意味着第二次访问这些路径时先校验会话，再复用资源字节。RPC 延迟不变：这个插件去掉的是静态资源的往返，不是 RPC 的往返。

## 安装（容器部署）

镜像内已经带有 `/opt/static-cache` 插件。每个 profile 启用一次：

```sh
docker compose --env-file server.env exec harness sh /opt/static-cache/enable.sh
docker compose --env-file server.env restart harness
```

脚本执行 profile 需要的两步：

1. 把包复制到 `<profile>/node_modules/@perhydrol/dsh-static-cache`，并写入 `<profile>/package.json` 的 `dependencies`；
2. 如果 profile 的 `cordis.patch.yml` 里还没有对应行，追加一条 `insert` 行。

两步都是幂等的。profile 位于 `data` 卷，容器重建后仍然有效；从旧卷恢复后重新运行脚本即可。

## 配置

行的 `config` 支持下列字段，全部可选。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `route` | `/__dsh-static-cache/sw.js` | 提供 worker 脚本的路径 |
| `scope` | `/` | worker 作用域；每个前缀都必须位于其中 |
| `prefixes` | `["/assets/", "/plugins/"]` | 可缓存路径前缀 |
| `exclude` | `["/plugins/events"]` | 始终走网络的确切路径 |
| `prime` | `true` | 页面加载后抓取并保存当前页资源 |
| `concurrency` | `4` | 并行预取请求数 |
| `maxCacheBytes` | 64 MiB | 整个缓存上限；最久未写入的条目先淘汰 |
| `maxEntryBytes` | 32 MiB | 超过该体积的响应只转发、不保存 |
| `graceMinutes` | `10` | 部署后上一代 build 的条目保留时长 |
| `maxAgeDays` | `30` | 超过该天数未再写入的条目会被删除，不论页面是否仍在引用 |

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
* `maxAgeDays` 与 `maxCacheBytes` 分别约束条目的保留时长与总量。

稳定路径的包资源（`/plugins/<pkg>/assets/*`）依赖客户端图版本，而版本哈希的是 bundle 产物而不是这些文件本身。只改资源、所有 bundle 字节不变时，旧资源可能保留到 `maxAgeDays`；这类更新需要重建 bundle，或调低该上限。

## 验证

在 DevTools 中两次打开同一个已登录页面：

* 第二次加载时，Network 里 `/assets/*` 与 `/plugins/*` 显示 `(ServiceWorker)`，传输字节为 0；
* `/api/*` 仍然出现在网络面板中；
* `await __DSH_STATIC_CACHE__.stats()` 返回 `entries`、`bytes`、`rev`、`hits`、`evicted`、`reconciled`、`lastPrune`；其中 `entries`/`bytes` 是元数据对账后仍在缓存中的条目；
* 注册失败会在控制台输出一条 `console.warn`，不再静默；
* 登出并回到登录页后，`caches.keys()` 为空。

启用插件后的第一次已登录加载会额外下载一次资源以填充缓存；之后一直复用，直到部署发生变化。

## 卸载

从 profile 的 `cordis.patch.yml` 删除 `static-cache` 行并重启。worker 不再注册；浏览器里的缓存字节会在访问登录页或清除站点数据时消失。插件仍启用时，可以调用 `await __DSH_STATIC_CACHE__.purge()` 立即清空。

## 安全说明

* worker 路由位于部署的反向代理之后，和 DSH 其他路径一样需要会话。
* 只保存版本化的静态字节。worker 拒绝 HTML、API 响应、SSE、重定向响应、Range 请求以及任何带 `Set-Cookie` 的响应，缓存中不包含会话状态。
* 缓存条目位于浏览器 profile 内；同一设备上的未登录用户无法打开应用，且下一次访问登录页会清空缓存。

## 限制

* RPC 调用的本地延迟不变。
* 缓存按浏览器 profile 和 origin 隔离；无痕会话从空缓存开始。
* Service Worker 需要 HTTPS 或回环地址。
* 浏览器存储压力或"清除站点数据"会清空缓存；下一次已登录加载会重新填充。

## 测试

```sh
cd experiments/public-auth/static-cache && node --test tests/*.test.js
```

Service Worker 测试在 VM 中用假的 Cache Storage 执行真实 worker 源码，覆盖代际切换、宽限期清理、登出清理、预热、淘汰和流式响应。
