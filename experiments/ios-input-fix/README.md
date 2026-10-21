# iOS 输入适配插件

独立 DSH 组合包，针对 iPhone/iPad 触摸浏览器的对话输入放大和键盘遮挡，不修改 DSH 主项目或已保存的用户设置，可与字体替换插件同时启用。

## 安装与停用

在 DSH 创造模式中，通过 `plugin_manager` 使用 `action: install_bundle`，将 `target` 设为本目录的绝对路径。需要 Web profile 提供 Client Layout、Conversation 和 `shell.overlay`。目录内包含可直接加载的 `client.js`，安装时不运行构建脚本。启用后刷新页面，从未放大的状态开始验证。停用插件会卸载样式和事件监听器，恢复宿主布局。

## 作用范围

通过 `-webkit-touch-callout` 支持检测和 `any-pointer: coarse` 限定 iOS 触摸环境。对话输入和占位文字的字体下限为 16px，更大的字号设置继续生效；正文、代码字体与字号偏好保持原值。这个下限处理聚焦放大，不代表键盘适配本身。

`visualViewport.resize` 和 `scroll` 提供可见区域的宽高与偏移，插件按帧合并更新，并通过自身 React 样式节点让 `#root` 匹配该矩形；原有 Grid/Flex 布局随高度收缩。容器留出系统报告的安全区域，不清零滚动、不重新聚焦、不修改 viewport meta，也不禁止手动缩放。用户双指缩放期间保留最后一次未缩放的布局，停止追随缩放造成的视口变化。缺少 VisualViewport 时仅应用对话输入字号下限。

这里的 `#root`、`data-composer-card`、`data-composer-input` 与 `data-composer-placeholder` 来自当前 DSH 源码；升级宿主后需复核。插件不处理端口外的登录页面、iframe 或挂载在 `document.body` 下的独立弹层；键盘动画中 Safari 延迟报告视口数据时，插件也只能跟随浏览器提供的数据。当前实现不包含 PWA manifest、Service Worker 或离线缓存。

## 开发与验证

在仓库根目录运行 `node experiments/ios-input-fix/build.mjs` 生成 Client 脚本，使用仓库已有的 tsdown，无额外运行时依赖。`src/` 是源码，`client.js` 是供 DSH 动态模块加载器运行的经典脚本。修改后先运行 `node --test experiments/ios-input-fix/tests/viewport.test.js`，再重新构建。使用仓库 oxlint 并指定本目录 `oxlint.json` 检查所有 JavaScript 文件。

单元测试验证键盘矩形、视口偏移、横竖屏尺寸、双指缩放暂停、帧合并、监听器和待执行帧释放；这些检查不模拟 iOS 键盘。图标为插件原创。

真机验收：以 390 CSS px 左右宽度打开长会话，输入中文和英文、换行、滚动聊天及输入区，确认键盘上方能操作发送按钮；收起键盘后检查布局恢复；再检查横屏、手动双指缩放、字号大于 16px、Safari 与主屏幕 Web App，并停用插件验证恢复。桌面和 Android 不应应用插件样式。

当前未安装到目标 profile，尚未完成 iOS 真机验证，不能将单元测试通过视为截图中的错位已经消失。
