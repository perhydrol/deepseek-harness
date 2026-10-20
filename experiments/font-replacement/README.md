# DSH 字体替换插件

可安装的独立实验组合包，仅替换字体，不调整字号、配色或布局。

| 字体设置 | 使用字体 |
| --- | --- |
| 正文，包括普通界面与对话正文 | HarmonyOS Sans SC（鸿蒙黑体） |
| 代码 | Maple Mono NL NF CN |
| 侧栏终端 | Maple Mono NL NF CN |

## 安装

在 DSH 创造模式中，通过 `plugin_manager` 调用 `action: install_bundle`，将 `target` 指向此目录的绝对路径。需要包含 `webServer`、Client Layout 和 Client Theme 的 Web profile。此目录不属于仓库 workspace，无需修改主项目或安装额外依赖。

插件通过 Host 提供同源字体资源，通过 `shell.overlay` 注册不占空间的样式表节点。字体加载成功后调用 `ctx.theme.setFontFamily`；终端先加载代表字符，再触发字体测量。资源按原始 `unicode-range` 分片加载，保留 400、500–600 和 700 字重，不依赖原字体目录或外部 CDN。

## 设置与停用

字体选择通过 DSH 设置接口持久化，现有三类字体偏好会被替换。每次插件挂载都会重新选择上述字体；挂载后仍可在设置中自行修改。停用插件会移除样式表和字体资源路由，但保留已保存的字体偏好；未在系统安装的字体会回退到 DSH 默认字体栈。要恢复原字体，请在停用后清空设置中的三类字体输入框，或填回自己原来的字体列表。插件不保存原偏好。

刷新页面时，终端可能先按回退字体测量已保存的 Maple 字体名。字体成功加载后，若终端偏好已经等于目标名称，插件先同步提交一次默认终端字体，再恢复 Maple，触发重新测量。这会额外保存两次终端字体偏好，并同步到同一设置范围内的其他窗口；字体加载失败或组件已经卸载时不执行此切换。

## 资源与验证

`fonts/` 完整分发用户提供的 `helia-ai/public/fonts` 中 1001 个 WOFF2 分片、字体声明与两个 `LICENSE.txt`，仅将 CSS 中的 `/fonts/` URL 改为插件专属的 `/font-replacement/`。该来源不含原始 TTF/OTF。`icon.svg` 是本插件原创图标。

Host 加载时计算每个字体分片的 SHA-256，将响应样式表中的 URL 改为内容哈希路径。字体响应使用 `Cache-Control: public, max-age=31536000, immutable`，适合浏览器磁盘缓存；字节变化会产生新 URL。样式表使用 `Cache-Control: no-cache`、ETag 和条件请求 304，允许本地存储并在复用前校验版本。不使用 Service Worker 或 IndexedDB，不预下载未使用的分片。更新资源后需重启插件，以重新生成哈希索引。

运行 `node --test tests/assets.test.js` 检查资源交付、访问范围与路由释放；使用仓库已安装的 `oxlint`，指定 `--config experiments/font-replacement/oxlint.json` 检查 `index.js`、`client.js` 和 `tests/assets.test.js`。

安装后应在真实 DSH 页面验证正文、代码块、行内代码和侧栏终端的字形、终端对齐，以及两种主题和字体设置。静态检查与 HTTP 测试不能代替真实页面验证。
