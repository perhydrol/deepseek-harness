---
description: "Authenticate one browser operator with passwords and discoverable passkeys."
kind: "package-reference"
---

# @hydrogen/dsh-browser-auth-single-user

English | [中文](README.zh.md)

## Summary

Provides `ctx.browserAuth` using an initialized private store and the required WebServer request gate. It grants the existing operator permissions without a username or account registry.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Use the optional [single-user bundle](../../bundle/single-user-auth/README.md). Configure canonical HTTPS `publicOrigin`, matching `rpId` and `mountPath`. An HTTP upstream requires explicit proxy peers and a single-valued client-IP header. Direct HTTPS requires listener TLS. The listener must set `requireRequestGate: true`.

<a id="understand-the-implementation"></a>
## Understand the implementation

Passwords use bounded scrypt work and an instance-owned queue. Sessions, passkeys and security metadata persist; CSRF preauthentication, challenges, reauthentication grants and rate limits are process-local. Management proofs are one-use and action-bound. Session expiry and revocation cancel admitted carriers. Anonymous access is restricted to the exact login resources and login operations. `POST /auth/security/state` requires a live session and its CSRF proof and returns only redacted credential metadata and the active-session count.

## Dev Note

This package is private and is not published to the public registry.

<a id="model-experience"></a>
## Model Experience

None, as browser authentication contributes no model input or Session events.

#### KV Cache effect

None; authentication does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The backend supports Linux only. Browser WebAuthn selects the authenticator; the application cannot require a particular biometric modality. Restart discards pending ceremonies. Canonical deployment changes require offline reconfiguration. See [configuration](src/config.ts), [operations](src/operations.ts) and the [Docker guide](../../../docs/user/guide/docker-deployment.md).
