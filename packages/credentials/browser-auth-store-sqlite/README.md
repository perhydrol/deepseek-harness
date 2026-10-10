---
description: "Store browser credentials in an exclusively owned Linux SQLite database."
kind: "package-reference"
---

# @hydrogen/dsh-browser-auth-store-sqlite

English | [中文](README.zh.md)

## Summary

Provides `ctx.browserAuthStore` to the single-user authentication provider. It opens an initialized database; use offline CLI maintenance before starting the Host.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Configure an absolute `path` in the store row. The database and its canonical parent directory must belong to the current Linux user and remain private. The store holds a nonblocking kernel flock for its lifetime; another Host or maintenance command cannot share ownership.

<a id="understand-the-implementation"></a>
## Understand the implementation

`openAuthStore` supports initialization and opening existing data. SQLite uses WAL, FULL synchronous commits and schema version 1. Each commit publishes an immutable state synchronously. Storage identity changes, uncertain commits or publication failures abort admissions; stop the Host and recover offline. The owner closes SQLite before releasing its lock.

## Dev Note

This package is private and is not published to the public registry.

<a id="model-experience"></a>
## Model Experience

None, as browser authentication contributes no model input or Session events.

#### KV Cache effect

None; authentication does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Linux only; accepted filesystem probes are ext4, xfs, btrfs and overlay. Persistent backing storage and backup recovery still require deployment validation. Authentication data is separate from Session logs.
