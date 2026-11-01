# Single-container deployment

English | [中文](README.zh.md)

The image `ghcr.io/perhydrol/dsh-used-by-self` uses npm to install the pinned official package `@deepseek-ai/dsh@0.2.1-rc.2` without compiling or modifying DSH source. The independent TypeScript proxy uses pnpm and its lockfile for dependency installation, compilation, and tests; pnpm is present only in the build stage. Supervisor runs as UID/GID `1000:1000`, manages both processes and their process groups, and owns restarts and shutdown; it does not isolate their permissions.

## First deployment

Requires Linux Docker, the Compose plugin, and an existing HTTPS reverse proxy that can reach the host loopback address. Run these commands from this directory. Copy the configuration and edit the hostname; `server.env` contains deployment configuration and an optional API key and must remain private and uncommitted. Private GHCR images require registry login first.

```sh
cp server.env.example server.env
chmod 600 server.env
docker compose --env-file server.env pull
docker compose --env-file server.env run --rm --no-deps --entrypoint node harness /opt/auth/dist/main.js init --state /var/lib/dsh-auth
docker compose --env-file server.env up -d
docker compose --env-file server.env ps
```

Initialization displays a random administrator password once; save it in a password manager. Do not initialize an existing administrator again. DSH's private launch URL is captured into `/run/dsh/launch-url` inside the container, and the proxy waits for readiness before exchanging its internal cookie; URL tokens on stdout and stderr are redacted. DSH restarts replace the file. Changes to the official CLI startup output fail readiness until the adapter is updated.

Add the [Nginx example](nginx.conf.example) to the existing TLS site, preserving external Host, Origin, and WebSocket upgrades and disabling caching and buffering. The example assumes Nginx runs on the host or uses host networking; a bridge-networked Nginx container cannot reach the host through its own `127.0.0.1`. Open `PUBLIC_ORIGIN` to sign in. Public access requires HTTPS; frontends such as Cloudflare must not cache authenticated pages or API responses either.

Compose publishes only the auth proxy at host `127.0.0.1:3080`; DSH listens only at container `127.0.0.1:3081` with no published port. The default working directory and HOME are both `/home/node`. Enter fish with `docker compose --env-file server.env exec harness fish`; the editor command is `nvim`. DSH's Bash tools continue using Bash.

## Nginx and client IP addresses

The supplied Compose and Nginx files support Nginx on the Docker host or using host networking: browser → HTTPS Nginx → host `127.0.0.1:3080` → authentication proxy. Keep the loopback port binding. A bridge-networked Nginx container needs a separately configured private route to the auth proxy; changing the upstream hostname alone does not expose the host's loopback listener to that container. Do not publish the auth proxy to the public network to solve this connectivity problem.

Set `TRUSTED_PROXY_IPS` in `server.env` to a comma-separated list of literal IPv4 or IPv6 socket-peer addresses that belong to your Nginx path. Empty (the default) trusts no proxy; hostnames, CIDRs, IPv6 zone identifiers, and wildcards are rejected at startup. For the reported host-networked Nginx and Docker bridge topology, `TRUSTED_PROXY_IPS=172.20.0.1` is an example to verify on the target server, not a built-in default. Use the address seen by the auth proxy, not the browser IP or the auth container IP. Recreate the service after changing this value using the update command below.

Inside the existing Nginx `location /`, replace incoming forwarding headers with the client address observed by Nginx, as in the [supplied example](nginx.conf.example):

```nginx
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Real-IP $remote_addr;
```

Use replacement rather than `$proxy_add_x_forwarded_for` when a single address is intended; the latter retains an incoming forwarding chain. See the [Nginx proxy module reference](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header). If a CDN or another proxy precedes Nginx, its address is the connection peer until Nginx's [real IP module](https://nginx.org/en/docs/http/ngx_http_realip_module.html) is configured to accept the provider's client-IP header only from that provider's trusted source ranges. Do not trust arbitrary sources to supply replacement addresses.

The auth proxy accepts exactly one valid `X-Forwarded-For` IP from configured peers and uses it for both activity records and Better Auth limits. Trusted peers with missing, invalid, or chained values receive HTTP 400. Forwarding headers from other peers are ignored, and the socket-peer IP is used. Fastify keeps `trustProxy: false`; forwarded Host and protocol values do not change Host checks or the configured public origin. Limit access to the backend: any process that can reach it through the same trusted Docker gateway can impersonate a proxy. Keep the loopback port binding and restrict untrusted local processes and containers.

The target-server operator must verify Nginx configuration and reload it, recreate the auth container with the updated image and environment, then test login and a live WebSocket over HTTPS. Confirm the backend is unreachable externally and check the client address in Nginx logs. Better Auth groups IPv6 login limits by /64 by default; activity records retain the resolved IP. Test two IPv4 addresses or IPv6 addresses in different /64 prefixes to confirm independent login budgets, and confirm that supplying a forged `X-Forwarded-For` through Nginx cannot select another budget. Local tests cover address resolution and login limits; the target Docker network and TLS deployment require this acceptance.

## Persistence and configuration

| Container path | Purpose |
|---|---|
| `/home/node` | Default working directory, projects, fish and Neovim configuration |
| `/var/lib/dsh` | DSH profiles, settings, credentials, and sessions |
| `/var/lib/dsh-auth` | Administrator, browser sessions, and signing secret |
| `/var/lib/uv` | Python virtual environment, tools, and cache |
| `/run/dsh` | Ephemeral private launch URL, regenerated on recreation |

Compose mounts one named volume at `/data`. The paths `/home/node`, `/var/lib/dsh`, `/var/lib/dsh-auth`, and `/var/lib/uv` are symbolic links to its `home`, `dsh`, `auth`, and `uv` subdirectories. `TMPDIR=/data/tmp` places default temporary environments on the same mount as the uv cache. Hard links work between these directories; do not replace the symbolic links with separate mounts. Explicit `/tmp` paths and additional project mounts can still cause uv to fall back to copying. Temporary files in `/data/tmp` persist across container recreation and require normal application cleanup.

The named volume inherits ownership from the image; a bind mount must contain the initialized directory tree and allow UID/GID `1000:1000` to write. Stop the container before backups and protect both the signing secret and database. Retain the volume during updates; do not use `down -v`. Install Python packages with `uv pip install` or `uv tool install`; project-specific `uv run` environments live in project directories. A system Python change may require recreating the default virtual environment.

To replace a disposable deployment using the four-volume layout, run `docker compose --env-file server.env down -v` with its old Compose file before replacing the file and image. This deletes all its named-volume data, including projects, credentials, and login sessions. Then follow the first-deployment initialization steps with the new Compose file. Existing data is not migrated automatically.

`PUBLIC_ORIGIN` is required and must be an HTTPS origin without a path; loopback HTTP is allowed for local trials. `DEEPSEEK_API_KEY` is optional; model credentials can also be configured in DSH. `SESSION_DAYS` defaults to 30, `LOGIN_ATTEMPTS` to 5, and `LOGIN_WINDOW_SECONDS` to 60; each must be a positive integer, and changes require container recreation. `SESSION_CACHE_SECONDS` defaults to 60 and must be a non-negative integer; `0` disables the in-process validated-session cache. See the [proxy reference](../README.md) for session and failure recovery behavior.

## Build and update

```sh
docker compose --env-file server.env build --pull
docker compose --env-file server.env up -d
```

Local builds use this directory's Dockerfile. Change its `DSH_VERSION` default to select an official package version; unpublished source features are absent from the image. Debian supplies fish, Neovim, Bash, Git, SSH, ripgrep, Python, Pandoc, Poppler utilities (including `pdftoppm`), htop, and Supervisor; uv comes from its official image.

Master pushes that change this project or the image workflow build Linux amd64 images and publish `latest` and `sha-<short-commit>` only after validation; manual dispatch is also available. Pin a deployment by changing the Compose image to a commit tag. Upstream workflows retain only manual or reusable entrypoints; jobs requiring PR or Issue event data do not thereby become fully functional manual workflows.

## Verification scope

The local Windows host has no Docker engine. The image workflow owns the build, Compose validation, tool checks, and checks of first login, DSH child crash recovery, persistent login after container restart, token redaction in logs, and shutdown; publication follows those checks. Probes use the Node HTTP API to set the external Host explicitly without following redirects; failures print container logs and health status with credentials redacted. The container health check probes DSH and the auth proxy; an `unhealthy` status alone does not make Docker restart the container. Target-server TLS, mount permissions, and model calls still require deployment acceptance.
