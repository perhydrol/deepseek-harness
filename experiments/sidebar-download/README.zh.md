---
description: "从侧边栏下载工作区文件，目录或多选文件先在服务端打包为 ZIP。"
kind: "package-bundle"
---

# 侧边栏下载

[English](README.md) | 中文

## 概述

这个可选 Web 组合包在文件标签页的刷新按钮旁添加下载按钮。选择窗口浏览当前会话的工作区，并在切换目录时保留选择。单文件原样下载；目录或多选内容在 Host 上生成 ZIP 后传输。先点击准备下载，再点击保存下载；第二次点击也为移动浏览器提供明确的保存手势。

## 目录

- [使用](#使用)
- [实现](#实现)
- [已知限制](#已知限制)
- [开发](#开发)

## 使用

组合补丁为 [cordis.patch.yml](cordis.patch.yml)。在 DSH 创造模式中，通过 `plugin_manager` 使用 `action: install_bundle`，将本目录的绝对路径作为 `target` 安装。本环境尚未验证目标 profile 安装。Profile 需要提供 Web Connection、工作区文件服务、会话、沙盒策略和文件侧边栏插槽。目录包含 JavaScript 产物；安装时需要声明的 Archiver 依赖，不需要运行构建脚本。激活后刷新浏览器。

在窗口中勾选文件或目录，通过箭头按钮进入目录，再准备所选内容。选择目录会递归包含其中内容，包括隐藏文件；同时选中目录及其子项时，每个条目只包含一次。ZIP 保留工作区相对路径和空目录。清空选择会取消所有勾选。取消或关闭窗口会中止准备；选择变化和关闭会请求释放尚未使用的下载，过期清理作为兜底。每个准备好的链接只能使用一次，已使用或过期时重新点击准备下载。保存链接表示内容已准备好，不表示浏览器已经完成保存。

补丁配置以下部署限制。正数计数和时间必须是安全整数，`compressionLevel` 接受 0 到 9 的整数。现有工作区服务的单次字节窗口和目录列表上限仍然生效；列表截断或条目不可读时，整次准备失败。在组合条目的 config 中调整这些值。

| 字段 | 值 | 含义 |
|---|---|---|
| `maxBytes` | 134217728 | 未压缩文件内容总字节上限 |
| `maxEntries` | 5000 | 所选及递归访问条目上限 |
| `maxConcurrent` | 2 | 准备、列表及传输中的请求总并发上限 |
| `chunkBytes` | 262144 | 每次向文件服务请求的字节窗口上限 |
| `compressionLevel` | 3 | 原生 zlib 压缩等级 |
| `maxPreparedDownloads` | 4 | 准备中和尚未使用的下载总数量上限 |
| `preparedTtlMs` | 300000 | 未使用下载的保留时间，单位为毫秒 |
| `temporaryDirectory` | Host `os.tmpdir()` | 可选的私有临时输出绝对目录 |

## 实现

<details>
<summary>实现细节</summary>

Client 只通过 `sidebar.right.tab.files.actions` 贡献入口，不检查或替换文件树 DOM。原生模态对话框提供焦点约束和 Escape 关闭。Host 对每个请求执行 Connection 登录校验，仅接受 owner 身份。它解析会话头，再通过组合中的工作区文件服务列目录、读取所选内容。目录别名、不可移植的归档路径、不支持的条目和不完整列表都会在返回下载之前失败。不添加模型工具：将内容保存到用户浏览器属于用户操作，不修改应用数据。

Host 逐个文件分块读取，通过 Archiver 的原生异步 zlib 流压缩。流背压限制排队的文件数据；Host 写入私有临时文件，准备完整后才返回随机、短期有效的下载票据。已登录的 GET 消费该票据，将文件流交给浏览器原生下载管理器，不创建浏览器 Blob。准备失败、取消、已消费的传输、显式释放、过期和插件卸载都会清理临时输出。卸载时先注销路由，中止请求，并等待读取及清理完成。每个文件在各字节窗口间的版本必须保持稳定，但整组选项不是原子文件系统快照。

</details>

## 已知限制

本组合包面向 Web profile 和已登录的所有者浏览器，不支持共享身份或仅桌面运行的 profile。现有文件树插槽仅提供显示目录，不提供行选择，因此插件提供自己的选择窗口。准备过程需要临时磁盘空间：未使用及准备中的输出与活动传输分别限额，应为 `(maxPreparedDownloads + maxConcurrent) × maxBytes` 加 ZIP 元数据开销预留空间。进程崩溃可能遗留临时目录，需要主机正常清理。符号链接不会作为链接归档；路径别名被拒绝，文件符号链接沿用现有读取服务的拒绝行为。通过独立 [public-auth 代理](../public-auth) 的实际 HTTP 联调测试已验证登录拦截、二进制及 ZIP 内容、中文附件文件名和票据重复使用拒绝，无需修改该代理。UI 渲染、目标 profile 安装和 iOS 保存仍需实际验证。

## 开发

TypeScript 源码位于 [src](src)，可安装产物为 [lib/index.js](lib/index.js) 和 [client.js](client.js)。在仓库中通过 `node experiments/sidebar-download/build.mjs` 使用已有 tsdown 构建两端产物。类型检查使用 `node node_modules/typescript/bin/tsc -p experiments/sidebar-download/tsconfig.json`。安装本插件及 public-auth 的依赖后，在仓库根目录通过 `node --import tsx/esm --test experiments/sidebar-download/tests/*.test.js` 运行测试。测试覆盖精确字节、ZIP 内容、空目录、路径穿越、截断、配额、登录校验、卸载、代理传输、版本变化和半成品清理。16 MiB 合成输入用于验证读取窗口有界、事件循环能继续运行，不是部署吞吐基准。Archiver 使用 MIT 许可证，作为外部运行时依赖安装；JSZip 仅用于测试中检查 ZIP。图标为原创。
