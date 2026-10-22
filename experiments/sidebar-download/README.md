---
description: "Download workspace files from the sidebar, with server-side ZIP preparation for directories and multiple files."
kind: "package-bundle"
---

# Sidebar downloads

English | [中文](README.zh.md)

## Summary

This optional Web bundle adds a Download button beside the Files tab's reload action. Its selection dialog browses the current session's workspace and keeps selections across directories. One file downloads unchanged; directories and multiple selections become a ZIP on the Host before transfer. Click Prepare download, then Save download; the second click also supplies an explicit save gesture on mobile browsers.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known limitations](#known-limitations)
- [Development](#development)

## Use this package

The bundle patch is [cordis.patch.yml](cordis.patch.yml). In DSH creation mode, install this directory through `plugin_manager` with `action: install_bundle` and its absolute directory as `target`. Installation into the target profile has not been verified in this environment. The profile must provide the Web connection, workspace file service, sessions, sandbox policy, and Files sidebar slot. JavaScript artifacts are included; installing the bundle requires its declared Archiver dependency but no build script. Reload the browser after activation.

Check files or directories in the dialog, navigate into directories with the arrow button, and prepare the selection. Selecting a directory includes its contents recursively, including hidden files; selecting both a directory and its descendants includes each entry once. The ZIP preserves paths relative to the workspace and retains empty directories. Clear selection removes all checked items. Cancel or closing the dialog aborts preparation; selection changes and closing request release of an unused prepared download, with expiry as the fallback. Each prepared link works once; click Prepare download again to retry a consumed or expired link. A save link indicates that bytes are ready, not that the browser has finished saving them.

The patch configures the following deployment limits. Positive counts and durations must be safe integers; `compressionLevel` accepts integers from 0 through 9. The existing workspace service's per-window byte limit and directory-listing cap also apply; a truncated listing or unreadable entry fails the whole preparation. Change these values in the bundle row's config.

| Field | Value | Meaning |
|---|---|---|
| `maxBytes` | 134217728 | Maximum aggregate uncompressed file bytes |
| `maxEntries` | 5000 | Maximum selected and recursively visited entries |
| `maxConcurrent` | 2 | Maximum active preparation, listing, and transfer requests |
| `chunkBytes` | 262144 | Maximum bytes requested from the file service per window |
| `compressionLevel` | 3 | Native zlib compression level |
| `maxPreparedDownloads` | 4 | Maximum preparing and unused prepared downloads |
| `preparedTtlMs` | 300000 | Unused download retention, in milliseconds |
| `temporaryDirectory` | Host `os.tmpdir()` | Optional absolute directory for private temporary output |

## Understand the implementation

<details>
<summary>Implementation internals</summary>

The Client contributes only through `sidebar.right.tab.files.actions`; it does not inspect or replace file-tree DOM. A native modal dialog provides focus containment and Escape dismissal. The Host authenticates every request through Connection admission and accepts only owner principals. It resolves the session header, then uses the composed workspace file service to list and read selected content. Directory aliases, nonportable archive paths, unsupported entries, and incomplete listings fail before a download is returned. No model tool is added: saving bytes into the user's browser is a user action and does not mutate application data.

The Host reads one file at a time in bounded windows and compresses with Archiver's native asynchronous zlib streams. Stream backpressure limits queued file data; the Host writes a private temporary file and returns a random, short-lived download ticket only after preparation completes. An authenticated GET consumes the ticket and streams the file into the browser's native download manager, without a browser Blob. Preparation failures, cancellation, consumed transfers, explicit release, expiry, and plugin unload remove the temporary output. Unloading unregisters the route, aborts active requests, and awaits readers and cleanup. Each file's version must remain stable across windows; the selection is not an atomic filesystem snapshot.

</details>

## Known limitations

This bundle targets Web profiles and authenticated owner browsers; shared peers and desktop-only profiles are not supported. It supplies its own selector because the existing file-tree slot exposes only the displayed directory, not row selection. Preparation needs temporary disk space: unused/preparing outputs are capped separately from active transfers, so allow up to `(maxPreparedDownloads + maxConcurrent) × maxBytes` plus ZIP metadata overhead. Process crashes may leave temporary directories for normal host cleanup. Symlinks are not archived as links; aliases are refused, and file symlinks follow the existing reader's refusal. A real HTTP integration test through the separate [public-auth proxy](../public-auth) verifies login rejection, binary and ZIP content, Chinese attachment filenames, and ticket reuse refusal without changing that proxy. UI rendering, target-profile installation, and iOS saving still require live verification.

## Development

TypeScript sources are in [src](src); installable output is [lib/index.js](lib/index.js) and [client.js](client.js). The checkout's tsdown builds both outputs through `node experiments/sidebar-download/build.mjs`. Type checking uses `node node_modules/typescript/bin/tsc -p experiments/sidebar-download/tsconfig.json`. Tests use `node --import tsx/esm --test experiments/sidebar-download/tests/*.test.js` from the repository root with both this plugin's and public-auth's dependencies installed. Tests cover exact bytes, ZIP contents, empty directories, traversal, truncation, quotas, authentication, disposal, proxy delivery, version changes, and partial-output cleanup. A synthetic 16 MiB input verifies bounded read windows and continued event-loop turns; it is not a deployment throughput benchmark. Archiver is MIT licensed and installed as an external runtime dependency; JSZip is used only to inspect ZIPs in tests. The icon is original artwork.
