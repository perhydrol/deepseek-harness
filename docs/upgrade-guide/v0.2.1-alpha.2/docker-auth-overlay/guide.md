---
kind: upgrade-guide
description: Docker authentication deployment parameters require a separate read-only overlay for service startup and credential maintenance.
---

# Separate Docker authentication configuration

English | [中文](guide.zh.md)

## Change

The Docker deployment loads authentication parameters from `deploy/docker/auth.yml`, mounted read-only at `/etc/hydrogen-harness/auth.yml`, instead of storing them in the writable profile's `cordis.patch.yml`. Existing volumes retain their old configuration. Authentication databases and credentials keep their existing paths and formats.

## Migration

1. Stop Harness and back up the home volume and deployment configuration. Copy the `browser-auth-single-user` and `browser-auth-store` rows from the existing profile patch into `deploy/docker/auth.yml`, preserving the domain, proxy trust and database path.
2. Update the image and Compose configuration together. Remove any single-file mount targeting `/var/lib/dsh/profiles/server/cordis.patch.yml`; use the new read-only `auth.yml` mount. Ensure the service command includes `--patch /etc/hydrogen-harness/auth.yml` before application flags if you override the image's command.
3. Edit the actual profile patch inside the home volume: remove only the two authentication rows and preserve all other user settings. If the old file was bind-mounted, copy its remaining settings into the volume after removing that mount. Use `[]` if no rows remain. The profile directory and file must be writable by UID/GID `1000:1000`, with private directory permissions and file mode `600`.
4. Add `--patch /etc/hydrogen-harness/auth.yml` to every `auth init`, `auth reset-password` and `auth reconfigure` invocation. Do not initialize an existing database again or delete volumes.
5. Recreate the service. Confirm password login, preview acknowledgement persistence after reload, and the security page. Verify the deployment file remains unchanged after saving browser settings. See the [deployment guide](../../../user/guide/docker-deployment.md) for command examples.
