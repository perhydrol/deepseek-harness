---
description: "为 Web profile 增加私有单用户密码和通行密钥认证。"
kind: "package-bundle"
---

# @hydrogen/dsh-single-user-auth

[English](README.md) | 中文

## 概述

此私有 bundle 为 Web profile 增加密码和通行密钥登录。它要求 Linux 后端及已初始化的私有认证数据库。仅在选择此层后才会替换默认 profile 的启动令牌登录。此包在源码工作区内使用，不发布到 npm。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [继续探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

在 profile 的 `dsh.profile.bundles` 列表中，将 `@hydrogen/dsh-single-user-auth` 放在 Web bundle 之后。CLI 安装包含此私有工作区依赖。

为 `browser-auth-single-user` 行配置规范 `publicOrigin`、匹配的 `rpId`，并在上游终止 TLS 时配置明确的代理策略。此 bundle 不提供部署身份；缺少配置会阻止激活。`browser-auth-store` 行拥有私有数据库位置。服务器停止时初始化凭据。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部</summary>

[cordis.patch.yml](cordis.patch.yml) 禁用旧 `browser-auth` 行，插入独立的单用户提供者、SQLite 存储和认证 UI。此补丁要求 WebServer 请求门禁，覆盖启动及提供者卸载阶段。移除此层会恢复默认组合。Loader 补丁中的名称用于匹配已有插件，不会替换插件名称。

</details>

<a id="further-exploration"></a>
## 继续探索

- [Web bundle](../web-app/README.zh.md)
- [Docker 部署](../../../docs/user/guide/docker-deployment.zh.md)

## 开发备注

此包为私有包；维护配置时同步更新英文说明。

<a id="model-experience"></a>
## 模型体验

无，因为浏览器认证不提供模型输入或 Session 事件。

#### KV Cache 影响

无；认证不会改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 此包为私有包，无法通过注册表安装。认证存储和凭据维护要求 Linux。浏览器及部署验证需要目标环境和客户端设备。
