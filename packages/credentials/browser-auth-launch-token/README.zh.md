---
description: "配置进程启动链接与持久化签名浏览器 Cookie。"
kind: "package-reference"
---

# @hydrogen/dsh-browser-auth-launch-token

[English](README.md) | 中文

## 概述

打开启动时打印的应用 URL，即可建立签名浏览器 Cookie。现有签名记录和 Cookie 受众在重启后继续有效。这是 Web 和 Desktop 的默认提供者，Cookie 有效期可以配置。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

Web bundle 在 Connection 旁挂载此提供者。自定义组合必须同时挂载凭据提供者。`cookieMaxAgeDays` 在这里配置，不再放在 Connection 上；默认值为 30 天。

持久化签名记录仍为 `client-connection/browser-session`。HTTP 与 HTTPS Cookie 受众保持隔离。卸载提供者会中止其准入；重启保留签名 Cookie，同时改变进程启动 token。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

[launch-token.ts](src/launch-token.ts) 拥有 Cookie 签名和交换。[index.ts](src/index.ts) 适配监听器 TLS 状态并拥有提供者清理。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Connection](../../client/connection/README.zh.md)
- [凭据](../credentials/README.zh.md)
- [架构](../../../docs/architecture.zh.md)

## 开发备注

此包为私有包；维护配置时同步更新英文说明。

<a id="model-experience"></a>
## 模型体验

无，因为浏览器认证不提供模型输入或 Session 事件。

#### KV Cache 影响

无；认证不会改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 签名 Cookie 没有逐会话退出操作；替换签名记录并重新激活提供者会使它们失效。
