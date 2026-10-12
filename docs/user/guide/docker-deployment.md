# Deploy the private Docker image behind Cloudflare and Nginx

English | [中文](docker-deployment.zh.md)

This deployment serves `https://harness.example.com/` with single-user authentication. [Dockerfile](../../../Dockerfile) builds the workspace on Node 24 and Debian trixie, including private Hydrogen packages and Linux native components. It uses the official package sources.

Replace `harness.example.com` in the Dockerfile, [auth.yml](../../../deploy/docker/auth.yml) and Nginx template with your domain, and replace `nginx-proxy` in the commands with your Nginx container name. Keep personal deployment configuration outside version control.

## Prepare the server

Use Linux Docker and the Docker Compose plugin. Both Harness and Nginx must use host networking so that Nginx can reach the backend at `127.0.0.1:3080`. The backend binds only loopback. Confirm the existing Nginx network before starting:

```sh
docker inspect nginx-proxy --format '{{.HostConfig.NetworkMode}}'
```

The expected network mode is `host`. Create a proxied Cloudflare DNS record for `harness.example.com` and confirm that the existing origin certificate covers that name.

## Build and initialize

Run these commands from the repository root in the server's fish shell:

```fish
set -gx DSH_CLIENT_COMMIT_HASH (git rev-parse HEAD)
docker compose -f deploy/docker/compose.yaml build
docker compose -f deploy/docker/compose.yaml run --rm --no-deps harness auth init --profile server --patch /etc/hydrogen-harness/auth.yml
docker compose -f deploy/docker/compose.yaml up -d
```

The build argument supplies real version metadata without copying `.git` into the image. Initialization prompts for the password interactively; it never becomes an image layer or command-line argument. Initialize before starting the server. Model credentials can be supplied through `DEEPSEEK_API_KEY` in the invoking environment.

[compose.yaml](../../../deploy/docker/compose.yaml) initializes a named home volume with the [server profile](../../../deploy/docker/profile/package.json). Its writable `cordis.patch.yml` holds user preferences. The separate `auth.yml` is mounted read-only at `/etc/hydrogen-harness/auth.yml` and loaded with `--patch` after user settings. It defines the canonical origin, Passkey RP ID, trusted proxy and authentication database path; it contains no passwords or API keys. Both service startup and credential maintenance must load this overlay. Missing credentials prevent authentication startup.

## Add the Nginx site

Insert both server blocks from [harness.example.com.conf](../../../deploy/nginx/harness.example.com.conf) inside the existing `nginx.conf` `http` block. Keep the existing `connection_upgrade` map and Cloudflare IP allowlist. Then validate and reload Nginx:

```sh
docker exec nginx-proxy nginx -t
docker exec nginx-proxy nginx -s reload
```

The site preserves Host and WebSocket upgrades, disables response buffering and proxy caching, and overwrites `X-Hydrogen-Client-IP` with Cloudflare's `CF-Connecting-IP`. The existing Cloudflare origin-pull check and IP allowlist remain required. No Cookie rewriting is needed: the authentication provider issues its own Secure Cookie for the canonical HTTPS origin. Do not force-cache this site's authenticated pages or API responses in Cloudflare. See the [Cloudflare header reference](https://developers.cloudflare.com/fundamentals/reference/http-headers/) and [Nginx buffering reference](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_buffering).

Open `https://harness.example.com/`, sign in with the initialized password, and register a passkey from the security page.

## Persist data and maintain credentials

The `/home` volume preserves OS user files, including `/home/node`, which is the container's `HOME`. User-installed server profile plugins reside in `/var/lib/dsh/profiles/server/node_modules` and are covered by the existing home volume. Bundled packages remain part of the image under `/opt/harness`. Kubernetes deployments must explicitly mount persistent storage at `/home`, `/var/lib/dsh`, `/var/lib/uv` and `/workspace`; Dockerfile `VOLUME` declarations do not provision Kubernetes PVCs.

The home volume at `/var/lib/dsh` keeps the profile, authentication database, credentials and Sessions. The separate `/workspace` volume keeps project files. The image runs as UID/GID `1000:1000`; data mounts must be writable by that identity, and authentication directories must remain private. Keep `auth.yml` readable by the container and writable only by the deployment administrator; restart after editing it. Do not bind-mount the profile's `cordis.patch.yml` as a single file, even read-write: settings persistence replaces it by atomic rename. Use a local filesystem supported by the authentication store. An existing volume retains its profile when the image changes; follow the [migration guide](../../upgrade-guide/v0.2.1-alpha.2/docker-auth-overlay/guide.md) for existing deployments.

Stop the service before password maintenance:

```sh
docker compose -f deploy/docker/compose.yaml stop
docker compose -f deploy/docker/compose.yaml run --rm --no-deps harness auth reset-password --profile server --patch /etc/hydrogen-harness/auth.yml
docker compose -f deploy/docker/compose.yaml up -d
```

Keep the volumes when updating the image. This source-workspace image retains development dependencies to preserve private workspace links; it does not depend on publishing Hydrogen packages.

## Python environment

The image includes uv and uvx. The uv cache lives at `/var/lib/uv/cache`; managed Python installations, tool environments and their executables live at `/var/lib/uv/python/managed`, `/var/lib/uv/python/tools` and `/var/lib/uv/python/bin`. The default virtual environment at `/var/lib/uv/python/venv` is on PATH; packages installed with `uv pip install` persist in the separate read-write uv volume. No additional package indexes are configured.

Compose mounts the uv volume at `/var/lib/uv`. New Docker named volumes initialize the virtual environment from the image independently of an existing home volume. If an existing uv volume lacks the default virtual environment, or when using an empty bind-mounted directory, run this once before using the Python environment:

```sh
docker compose -f deploy/docker/compose.yaml run --rm --no-deps --entrypoint uv harness venv --python /usr/bin/python3 /var/lib/uv/python/venv
```

With the service running, install packages with `docker compose -f deploy/docker/compose.yaml exec harness uv pip install <package>` and standalone tools with `uv tool install <tool>`. Project-local `uv run` uses the project's environment; run scripts in the default environment with `python script.py`. `uv run --active <command>` targets the default environment and synchronizes project dependencies into it. Retaining the uv volume retains these packages; rebuild the default virtual environment and reinstall its dependencies when the image's system Python becomes incompatible with the existing environment.

## Verification scope

The Dockerfile, YAML and public CLI profile composition have local checks. The development machine has no Docker engine, so the complete image build, target-server startup and Nginx certificate validation remain to be executed on the server. Physical Windows Hello and FaceID qualification also requires the corresponding client devices.
