# AGENTS.md — GitHub Actions

This fork automatically runs only [deploy-image](workflows/deploy-image.yml), on relevant master pushes. It builds and validates the Linux deployment image on Ubuntu before publishing to GHCR. Upstream workflows retain manual and reusable entrypoints only; event-dependent upstream jobs may skip or require adaptation when dispatched manually. Preserve that restriction when importing upstream changes.

Run Windows jobs (`windows-*` labels) under native `pwsh`. Preserve the existing per-platform switches (`selfhosted` for in-house runners and `blacksmith` for hosted runners), Dependabot fallbacks, and reusable Python runtime platform inputs in retained upstream workflows.

The manual [Windows packaging workflow](workflows/windows-package.yml) uses the dedicated self-hosted Windows x64 label `dsh-win-package-trial` under native `pwsh`; preserve this routing separately from the automatic CI lanes.

The manual Desktop publication workflow selects a successful package run and attempt, then routes each retained build through `DESKTOP_PUBLISH_RUNNERS` to its original machine's unique label. Keep Windows run steps on native PowerShell and Mac run steps on the default POSIX shell; shared entrypoints are Node scripts. Test and production jobs use separate `desktop-test` and `desktop-production` approval Environments after a credential-free preparation job.
