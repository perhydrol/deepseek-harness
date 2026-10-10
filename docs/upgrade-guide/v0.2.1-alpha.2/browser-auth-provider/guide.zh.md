---
kind: upgrade-guide
description: "自定义 Connection 组合必须提供 browserAuth，并将签名 Cookie 有效期设置移到启动 token 提供者。"
---

# 浏览器认证提供者

[English](guide.md) | 中文

## 变更

Connection 要求 `ctx.browserAuth`，不再通过 `ctx.credentials` 构造浏览器认证。Web 和 Desktop profile 自动挂载启动 token 提供者。自定义 Connection 组合必须补充该提供者。`cookieMaxAgeDays` 属于提供者；残留的 Connection 设置会使激活失败。认证成功的 `PeerAdmission` 结果也携带会话 `lifetime`。

## 迁移

1. 在自定义 profile patch 或 Cordis 配置中，在 `@deepseek-ai/dsh-client-connection` 旁添加 `@hydrogen/dsh-browser-auth-launch-token`。保留凭据提供者。
2. 将 `cookieMaxAgeDays` 从 Connection 配置移到启动 token 提供者配置。
3. 直接构造 `HostConnectionService` 的适配器须传入 `@hydrogen/dsh-browser-auth` 的 `BrowserAuthHandle`。适配浏览器传输时继续传递准入生命周期。
4. 启动 profile 并打开打印的 URL。现有签名 Cookie 和 `client-connection/browser-session` 签名记录的格式保持不变。
