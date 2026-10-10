---
description: "Add private single-user password and passkey authentication to a Web profile."
kind: "package-bundle"
---

# @hydrogen/dsh-single-user-auth

English | [中文](README.zh.md)

## Summary

This private bundle adds password and passkey login to a Web profile. It requires a Linux backend and an initialized private authentication database. Default profiles keep launch-token login unless this layer is selected. The package is available inside this source workspace and is not published to npm.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Select `@hydrogen/dsh-single-user-auth` after the Web bundle in a profile's `dsh.profile.bundles` list. The CLI installation includes the private workspace dependency.

Configure the `browser-auth-single-user` row with the canonical `publicOrigin`, matching `rpId` and explicit proxy policy when TLS terminates upstream. The bundle supplies no deployment identity; missing configuration prevents activation. The `browser-auth-store` row owns the private database location. Initialize credentials while the server is stopped.

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals</summary>

[cordis.patch.yml](cordis.patch.yml) disables the legacy `browser-auth` row and inserts a distinct single-user provider, SQLite store and authentication UI. The patch requires the WebServer request gate, including startup and provider unload, and enables remote Host settings persistence through `ui-settings.allowRemotePersistence`. Removing this layer restores the default composition. Loader patch names match existing plugins; they do not replace plugin names.

</details>

<a id="further-exploration"></a>
## Further Exploration

- [Web bundle](../web-app/README.md)
- [Docker deployment](../../../docs/user/guide/docker-deployment.md)

## Dev Note

This package is private; update its paired documentation with configuration changes.

<a id="model-experience"></a>
## Model Experience

None, as browser authentication contributes no model input or Session events.

#### KV Cache effect

None; authentication does not change model requests.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- This package is private; registry installation is unavailable. Authentication storage and credential maintenance require Linux. Browser and deployment qualification require the target environment and client devices.
