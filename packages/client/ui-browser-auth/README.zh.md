---
description: "为单用户浏览器认证渲染独立的登录和安全页面。"
kind: "package-reference"
---

# @hydrogen/dsh-client-ui-browser-auth

[English](README.md) | 中文

## 概述

Host 提供独立的登录和安全文档及其资源。已认证客户端提供本地化安全设置入口，并检查会话失效。

## 目录

- [使用此包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

使用[单用户 bundle](../../bundle/single-user-auth/README.zh.md)。Host 需要单用户浏览器认证和必需的监听器准入检查。登录资源只包含认证代码；安全页面需要有效会话。

<a id="understand-the-implementation"></a>
## 实现说明

登录支持密码和显式浏览器通行密钥流程。安全管理支持注册、重命名、删除、修改密码和撤销会话。安全文档使用 `GET /auth/security`；经过认证的元数据使用独立的 `POST /auth/security/state` 接口。敏感修改消耗新取得的重新认证授权。证明仅保存在内存中。认证传输以独立函数调用，保持浏览器原生 fetch 的调用方式。客户端在业务模块启动前、连接丢失或窗口重新获得焦点后检查认证；传输故障保留可恢复状态。

## 开发备注

此包为私有包，不发布到公共注册表。

<a id="model-experience"></a>
## 模型体验

无，因为浏览器认证不提供模型输入或 Session 事件。

#### KV Cache 影响

无；认证不会改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 仅用于浏览器；通行密钥支持取决于安全浏览器上下文和设备能力。实体 Windows Hello 和 Face ID 验证需要对应设备。Host 激活前必须构建独立页面资源。
