---
kind: upgrade-guide
description: "Custom Connection compositions must provide browserAuth and move signed-cookie lifetime settings to the launch-token provider."
---

# Browser authentication provider

English | [中文](guide.zh.md)

## Change

Connection requires `ctx.browserAuth` instead of constructing browser authentication from `ctx.credentials`. Web and Desktop profiles mount the launch-token provider automatically. Custom Connection compositions must add it. `cookieMaxAgeDays` belongs to that provider; residual Connection settings fail activation. Authenticated `PeerAdmission` results also contain a session `lifetime`.

Single-user security metadata uses `POST /auth/security/state`; `GET /auth/security` serves only the page. Update direct callers and deploy matching Host and authentication-page assets together.

## Migration

1. Add `@hydrogen/dsh-browser-auth-launch-token` beside `@deepseek-ai/dsh-client-connection` in custom profile patches or Cordis configurations. Keep the credential provider.
2. Move `cookieMaxAgeDays` from the Connection config to the launch-token provider config.
3. Pass a `BrowserAuthHandle` from `@hydrogen/dsh-browser-auth` to direct `HostConnectionService` adapters. Propagate the admission lifetime when adapting browser transports.
4. Start the profile and open its printed URL. Existing signed cookies and the `client-connection/browser-session` signing record retain their formats.
