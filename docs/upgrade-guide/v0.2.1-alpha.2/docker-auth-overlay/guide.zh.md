---
kind: upgrade-guide
description: Docker 认证部署参数需要通过独立的只读覆盖文件供服务启动及凭据维护加载。
---

# 拆分 Docker 认证配置

[English](guide.md) | 中文

## 变更

Docker 部署从 `deploy/docker/auth.yml` 加载认证参数，将其只读挂载到 `/etc/hydrogen-harness/auth.yml`，不再将参数保存在可写 profile 的 `cordis.patch.yml` 中。已有卷会保留旧配置。认证数据库和凭据保持原有路径及格式。

## 迁移

1. 停止 Harness，并备份 home 卷及部署配置。将现有 profile patch 中的 `browser-auth-single-user` 和 `browser-auth-store` 两项复制到 `deploy/docker/auth.yml`，保留域名、代理信任配置及数据库路径。
2. 同时更新镜像和 Compose 配置。移除所有指向 `/var/lib/dsh/profiles/server/cordis.patch.yml` 的单文件挂载，使用新的只读 `auth.yml` 挂载。如果覆盖镜像的启动命令，确保在应用参数之前包含 `--patch /etc/hydrogen-harness/auth.yml`。
3. 编辑 home 卷内实际使用的 profile patch：只删除两项认证配置，保留其他用户设置。如果旧文件通过绑定挂载提供，移除挂载后将其剩余设置复制到卷内。没有剩余项时使用 `[]`。profile 目录及文件必须允许 UID/GID `1000:1000` 写入，目录保持私有权限，文件权限为 `600`。
4. 为每次 `auth init`、`auth reset-password` 和 `auth reconfigure` 调用添加 `--patch /etc/hydrogen-harness/auth.yml`。不要重新初始化已有数据库或删除数据卷。
5. 重建服务容器。确认密码登录、预览确认状态在刷新后保留，以及安全页面正常。验证保存浏览器设置后部署配置文件没有变化。命令示例见[部署指南](../../../user/guide/docker-deployment.zh.md)。
