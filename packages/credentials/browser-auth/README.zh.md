---
description: "消费由提供者拥有的浏览器认证与逐会话准入生命周期。"
kind: "package-reference"
---

# @hydrogen/dsh-browser-auth

[English](README.md) | 中文

## 概述

通过一个认证提供者接纳浏览器请求，并携带会话截止时间和撤销信号。Connection 消费该服务并保留 Host 与 Origin 检查。替换提供者无需引入账户或改变操作者 Peer。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

Connection 要求恰好一个 `ctx.browserAuth` 提供者。实现 [src/index.ts](src/index.ts) 声明的服务；不要直接挂载抽象定义。

`authenticate` 返回拒绝结果，或会话 ID、绝对 epoch 截止时间和撤销信号。消费者必须在分发前立即检查截止时间和信号；仅靠定时器不能保证过期。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

[types.ts](src/types.ts) 将浏览器会话与操作者身份分离。[request-trust.ts](src/request-trust.ts) 拥有共享 authority 与跨站检查。

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

- 认证授予现有操作者权限，不增加执行隔离。
