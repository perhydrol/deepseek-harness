---
description: "Render standalone login and security pages for single-user browser authentication."
kind: "package-reference"
---

# @hydrogen/dsh-client-ui-browser-auth

English | [中文](README.zh.md)

## Summary

The Host serves independent login and security documents and their assets. The authenticated client contributes a localized security-settings entry and checks session loss.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Use the [single-user bundle](../../bundle/single-user-auth/README.md). The Host requires single-user browser authentication and a required listener gate. Login resources contain only authentication code; the security page requires a live session.

<a id="understand-the-implementation"></a>
## Understand the implementation

Login supports password and explicit browser passkey ceremonies. Security management supports registration, rename, deletion, password changes and session revocation. Sensitive mutations consume fresh reauthentication grants. Proofs remain in memory. Authentication transports are called as standalone functions, preserving native browser fetch invocation. The client probes authentication before business-module startup and after connection loss or focus; transport failures preserve recoverable state.

## Dev Note

This package is private and is not published to the public registry.

<a id="model-experience"></a>
## Model Experience

None, as browser authentication contributes no model input or Session events.

#### KV Cache effect

None; authentication does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Browser-only UI; passkey support depends on a secure browser context and device capabilities. Physical Windows Hello and Face ID validation requires those devices. Standalone page assets must be built before Host activation.
