---
kind: upgrade-guide
description: Passkey ceremonies reject unexpected cross-origin context and registration rejects credential IDs exceeding 1023 bytes.
---

# Passkey response validation

English | [中文](guide.zh.md)

## Change

Passkey registration accepts omitted `credProps` and `rk` extension outputs. Registration and authentication reject cross-origin client data and any `topOrigin` field; this deployment supports same-origin ceremonies only. Registration rejects credential IDs exceeding 1023 decoded bytes. Existing credential storage and user handles retain their formats.

## Migration

1. Deploy the updated server and start a fresh registration or authentication ceremony; do not replay a response from an earlier challenge.
2. Run the security page as a top-level page on the configured public origin. Cross-origin embedded authentication is unsupported.
3. Confirm registration and subsequent passkey login with your authenticator. If it returns an oversized credential ID, use another authenticator or password login. Do not delete or reinitialize the authentication database.
