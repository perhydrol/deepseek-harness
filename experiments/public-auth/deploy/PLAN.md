# Single-container deployment plan

Goal: publish `ghcr.io/perhydrol/dsh-used-by-self` on master pushes, using a pinned official DSH package and the independent authentication proxy.

- [x] Add a launch-output adapter that atomically saves the private loopback URL and redacts tokens from stdout and stderr; test chunked output, invalid origins, replacement, and write failure.
- [x] Add container entry modes for DSH and the proxy, with Supervisor owning process groups and restarts. The proxy waits for the private URL before starting.
- [x] Add a Debian runtime image with fish, Neovim, uv, a non-root HOME/work directory, persistent volumes, and a Compose configuration for the existing external HTTPS proxy. Install official DSH with npm; use pnpm and its lockfile only for the proxy build.
- [x] Add the GHCR build workflow and restrict upstream workflows to manual or reusable invocation. Validate YAML and update affected workflow expectations.
- [x] Run focused TypeScript, lint, unit checks, the complete repository build, and self-review; obtain independent review. Dockerfile and YAML lint pass; bilingual pairing passes. The full doc-sync check also reports an unchanged Python lockfile reference violation, unavailable npm in the host check environment, and a documentation graph memory limit.
- [ ] Execute Docker build and Linux lifecycle smoke in the image workflow; this Windows host has no Docker engine.

Review focus: startup output changes must fail closed; credentials must stay out of logs and image layers; DSH restarts must replace the private URL; persisted admin state must survive image updates; only the auth listener may accept external traffic.
