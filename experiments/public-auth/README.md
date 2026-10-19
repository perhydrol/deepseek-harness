# Single-owner authentication proxy experiment

[中文](README.zh.md)

An independent TypeScript project, excluded from the DSH workspace. It can be moved to a separate repository. [Better Auth](https://better-auth.com/docs) owns password hashing, persistent sessions, signed cookies, CSRF protection, and rate limiting; [Fastify HTTP Proxy](https://github.com/fastify/fastify-http-proxy) owns HTTP streaming and WebSocket forwarding. DSH source and authentication remain unchanged: the proxy exchanges a private DSH launch URL for an internal cookie, while browsers receive a separate session cookie. The fixed upstream receives neither browser credentials nor client forwarding assertions.

Requires Node 24.19 or later and pnpm 11.25.0. Install and run from this directory:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm test
pnpm build
node dist/main.js init --state ./state
```

Initialization prints a generated administrator password once. Alternatively supply `--password-file FILE`; the file must contain 12 to 128 characters. Keep the signing secret and Better Auth SQLite database private and persist both. Initialization refuses to replace an existing owner. Public registration and other account-management endpoints are not mounted. Windows file permissions inherit from the parent directory; use your private user directory.

Start DSH separately through its normal `dsh web --no-open` launcher, binding a specific private or loopback address. Put its complete token-bearing root URL in `launch-url.txt`. This file is a server credential. Update it after DSH restarts; existing internal cookies remain usable while their signing secret and lifetime remain valid.

```sh
node dist/main.js serve --origin http://127.0.0.1:8080 --launch-url-file ./launch-url.txt --state ./state
```

Open `/`; browser document navigation redirects to `/_auth/login`. The persistent HttpOnly, SameSite=Strict cookie lasts 30 days by default (`--session-days`), with no sliding refresh. HTTPS origins additionally use Secure and the `__Secure-` prefix. Browser JavaScript never stores the credential in localStorage. `POST /_auth/logout` with a same-origin Origin header revokes that session and disconnects its WebSockets. Session expiry also disconnects its WebSockets. `GET /_auth/session` checks it.

Better Auth limits login attempts by socket IP, defaulting to five attempts per 60 seconds (`--login-attempts`, `--login-window-seconds`), persisting counters in SQLite. When a TLS proxy connects over loopback, clients share that proxy's budget; incoming forwarding headers cannot override it. Upstream mutations are never retried. On upstream 401 the proxy renews credentials for the next request, without replaying the failed request. Failed operations may have unknown outcomes; inspect DSH before repeating a change.

## Linux and Docker

```sh
docker build -t dsh-public-auth .
```

For Linux with DSH listening on host loopback, use host networking, mount this project's private state directory read-write and its launch URL file read-only, and run the same `serve` arguments. The image runs as the unprivileged `node` user; mounted state must be writable by that user. The default proxy bind remains `127.0.0.1`; place an HTTPS reverse proxy in front, preserving the external Host and WebSocket upgrades. Set `--origin https://YOUR_DOMAIN` and keep both the proxy's HTTP listener and DSH inaccessible from the public network. Public HTTP origins fail startup. TLS forwarding headers are ignored; the configured public origin controls Secure cookies.

This is a single-owner experiment, not user isolation. Anyone controlling DSH's agent execution may be able to access sibling services or credentials according to the server's process/container permissions. An authentication proxy does not confine agent tools. Tests cover a controlled upstream fixture; real DSH and Linux container validation must be reported separately.
