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

## Persistence and configuration

| Container path | Purpose |
|---|---|
| `/home/node` | Default working directory, projects, fish and Neovim configuration |
| `/var/lib/dsh` | DSH profiles, settings, credentials, and sessions |
| `/var/lib/dsh-auth` | Administrator, browser sessions, and signing secret |
| `/var/lib/uv` | Python virtual environment, tools, and cache |
| `/run/dsh` | Ephemeral private launch URL, regenerated on recreation |

Named volumes inherit ownership from the image; bind mounts must allow UID/GID `1000:1000` to write. Stop the container before backups and protect both the signing secret and database. Retain volumes during updates; do not use `down -v`. Install Python packages with `uv pip install` or `uv tool install` into the uv volume; project-specific `uv run` environments live in project directories. A system Python change may require recreating the default virtual environment.

`PUBLIC_ORIGIN` is required and must be an HTTPS origin without a path; loopback HTTP is allowed for local trials. `DEEPSEEK_API_KEY` is optional; model credentials can also be configured in DSH. `SESSION_DAYS` defaults to 30, `LOGIN_ATTEMPTS` to 5, and `LOGIN_WINDOW_SECONDS` to 60; each must be a positive integer, and changes require container recreation. See the [proxy reference](../README.md) for session and failure recovery behavior.

## Build and update

```sh
docker compose --env-file server.env build --pull
docker compose --env-file server.env up -d
```

Local builds use this directory's Dockerfile. Change its `DSH_VERSION` default to select an official package version; unpublished source features are absent from the image. Debian supplies fish, Neovim, Bash, Git, SSH, ripgrep, Python, and Supervisor; uv comes from its official image.

Master pushes that change this project or the image workflow build Linux amd64 images and publish `latest` and `sha-<short-commit>` only after validation; manual dispatch is also available. Pin a deployment by changing the Compose image to a commit tag. Upstream workflows retain only manual or reusable entrypoints; jobs requiring PR or Issue event data do not thereby become fully functional manual workflows.

## Verification scope

The local Windows host has no Docker engine. The image workflow owns the build, Compose validation, tool checks, and checks of first login, DSH child crash recovery, persistent login after container restart, token redaction in logs, and shutdown; publication follows those checks. The container health check probes DSH and the auth proxy; an `unhealthy` status alone does not make Docker restart the container. Target-server TLS, mount permissions, and model calls still require deployment acceptance.
