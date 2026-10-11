---
description: "使用密码和可发现通行密钥认证单个浏览器操作者。"
kind: "package-reference"
---

# @hydrogen/dsh-browser-auth-single-user

[English](README.md) | 中文

## 概述

通过已初始化的私有存储和必需的 WebServer 请求准入检查提供 `ctx.browserAuth`。它授予现有操作者权限，不需要用户名或账户注册表。

## 目录

- [使用此包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

使用可选的[单用户 bundle](../../bundle/single-user-auth/README.zh.md)。配置规范 HTTPS `publicOrigin`、匹配的 `rpId` 和 `mountPath`。HTTP 上游需要显式代理地址和单值客户端 IP 请求头。直接 HTTPS 需要监听器 TLS。监听器必须设置 `requireRequestGate: true`。

<a id="understand-the-implementation"></a>
## 实现说明

密码使用有资源上限的 scrypt 和实例独占队列。会话、通行密钥和安全元数据持久化；CSRF 预认证、挑战、重新认证授权和速率限制仅存在于进程中。管理证明只能使用一次且绑定操作。会话到期和撤销会取消已准入的传输。匿名访问仅限精确列出的登录资源和登录操作。`POST /auth/security/state` 要求有效会话及其 CSRF 证明，仅返回已脱敏的凭据元数据和有效会话数量。

通行密钥流程要求用户验证和同源客户端数据。注册请求可发现凭据且不要求认证器证明；可选的 `credProps.rk` 输出不作为验证依据。新注册凭据的 ID 解码后不得超过 1023 字节。SimpleWebAuthn 负责算法协商和密码学验证。

## 开发备注

此包为私有包，不发布到公共注册表。

<a id="model-experience"></a>
## 模型体验

无，因为浏览器认证不提供模型输入或 Session 事件。

#### KV Cache 影响

无；认证不会改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 后端仅支持 Linux。浏览器 WebAuthn 选择认证器；应用不能要求特定生物识别方式。重启会丢弃未完成的认证流程。规范部署信息变化需要离线重新配置。参见[配置](src/config.ts)、[操作](src/operations.ts)和 [Docker 指南](../../../docs/user/guide/docker-deployment.zh.md)。
