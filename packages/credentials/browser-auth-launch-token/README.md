---
description: "Configure process launch links and persistent signed browser cookies."
kind: "package-reference"
---

# @hydrogen/dsh-browser-auth-launch-token

English | [中文](README.zh.md)

## Summary

Open the application URL printed at startup to establish a signed browser cookie. Existing signing records and cookie audiences remain usable across restarts. This is the default provider for Web and Desktop; its cookie lifetime is configurable.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

The Web bundle mounts this provider beside Connection. Custom compositions must mount it with a credential provider. Set `cookieMaxAgeDays` here rather than on Connection; the default is 30 days.

The persisted signing record remains `client-connection/browser-session`. HTTP and HTTPS cookie audiences remain distinct. Unloading the provider aborts its admissions; restarting retains signed cookies while changing the process launch token.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[launch-token.ts](src/launch-token.ts) owns cookie signing and exchange. [index.ts](src/index.ts) adapts the listener TLS state and owns provider disposal.

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

- Signed cookies have no individual logout operation; replacing the signing record and reactivating the provider invalidates them.
