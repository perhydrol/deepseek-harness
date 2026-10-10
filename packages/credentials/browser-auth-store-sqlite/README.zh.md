---
description: "在独占的 Linux SQLite 数据库中保存浏览器凭据。"
kind: "package-reference"
---

# @hydrogen/dsh-browser-auth-store-sqlite

[English](README.md) | 中文

## 概述

为单用户认证提供者提供 `ctx.browserAuthStore`。它打开已初始化的数据库；启动 Host 前先执行离线 CLI 维护。

## 目录

- [使用此包](#use-this-package)
- [实现说明](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用此包

在存储配置行中设置绝对路径 `path`。数据库及其规范父目录必须属于当前 Linux 用户并保持私有。存储在整个生命周期持有非阻塞内核 flock；其他 Host 或维护命令不能同时持有它。

<a id="understand-the-implementation"></a>
## 实现说明

`openAuthStore` 支持初始化和打开已有数据。SQLite 使用 WAL、FULL 同步提交和 schema 版本 1。每次提交同步发布不可变状态。存储身份变化、提交结果不确定或发布失败都会中止准入；需要停止 Host 并离线恢复。存储所有者先关闭 SQLite，再释放锁。

## 开发备注

此包为私有包，不发布到公共注册表。

<a id="model-experience"></a>
## 模型体验

无，因为浏览器认证不提供模型输入或 Session 事件。

#### KV Cache 影响

无；认证不会改变模型请求。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 仅支持 Linux；接受的文件系统探测结果为 ext4、xfs、btrfs 和 overlay。持久化后备存储和备份恢复仍需部署验证。认证数据独立于 Session 日志。
