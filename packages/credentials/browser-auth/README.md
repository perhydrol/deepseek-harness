---
description: "Consume provider-owned browser authentication and per-session admission lifetimes."
kind: "package-reference"
---

# @hydrogen/dsh-browser-auth

English | [中文](README.zh.md)

## Summary

Use one authentication provider to admit browser requests with a session deadline and revocation signal. Connection consumes the service while keeping its Host and Origin checks. Providers can change without introducing accounts or changing the operator Peer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Connection requires exactly one `ctx.browserAuth` provider. Implement the service declared in [src/index.ts](src/index.ts); do not mount the abstract definition itself.

`authenticate` returns a rejection or a session ID, absolute epoch deadline and revocation signal. Consumers must check both deadline and signal immediately before dispatch; timers alone cannot enforce expiry.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[types.ts](src/types.ts) separates browser sessions from the operator identity. [request-trust.ts](src/request-trust.ts) owns shared authority and cross-site checks.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Connection](../../client/connection/README.md)
- [Credentials](../credentials/README.md)
- [Architecture](../../../docs/architecture.md)

## Dev Note

This package is private; update its paired documentation with configuration changes.

<a id="model-experience"></a>
## Model Experience

None, as browser authentication contributes no model input or Session events.

#### KV Cache effect

None; authentication does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Authentication grants the existing operator permissions; it adds no execution isolation.
