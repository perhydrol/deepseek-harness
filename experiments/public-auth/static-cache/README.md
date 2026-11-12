# dsh-static-cache

English | [中文](README.zh.md)

Browser-side cache for DSH Web static assets, installed as an out-of-tree
profile plugin. It keeps the deployment's authentication untouched: the
service worker only stores bytes that an authenticated page already fetched
with its session cookie.

## What it caches

| Path | Cached | Why |
|---|---|---|
| `/assets/*` (hashed JS, CSS, fonts, images) | yes | content-addressed, immutable |
| `/plugins/??...&rev=` (combo bundles, chunks, package assets) | yes | revisioned by DSH |
| `/` (index) | no | carries per-peer boot injections |
| `/api/*` | no | session-scoped responses |
| `/plugins/events` (SSE) | no | long-lived stream |
| `/_auth/*`, `/connect` | no | authentication |

Cache-first delivery means a second visit makes no network request for these
paths. API latency is unchanged: this plugin removes static round trips, not
RPC round trips.

## Install (container deployment)

The plugin ships at `/opt/static-cache` in the image. Enable it once per
profile:

```sh
docker compose --env-file server.env exec harness sh /opt/static-cache/enable.sh
docker compose --env-file server.env restart harness
```

The script performs the two steps the profile needs:

1. copies the package to `<profile>/node_modules/@perhydrol/dsh-static-cache`
   and records it under `dependencies` in `<profile>/package.json`;
2. appends an `insert` row for the plugin to the profile's `cordis.patch.yml`
   unless the row is already present.

Both steps are idempotent. The profile lives in the `data` volume, so they
survive container recreation; rerun the script after restoring an older volume.

## Configuration

The row's `config` accepts every field below; all are optional.

| Field | Default | Meaning |
|---|---|---|
| `route` | `/__dsh-static-cache/sw.js` | Path serving the worker script |
| `scope` | `/` | Worker scope; every prefix must live inside it |
| `prefixes` | `["/assets/", "/plugins/"]` | Cacheable path prefixes |
| `exclude` | `["/plugins/events"]` | Exact paths that always hit the network |
| `prime` | `true` | Fetch and store the current page's assets after load |
| `concurrency` | `4` | Parallel prefetch requests |
| `maxCacheBytes` | 64 MiB | Whole-cache bound; least recent entries evict first |
| `maxEntryBytes` | 32 MiB | Larger responses are served but never stored |
| `graceMinutes` | `10` | How long a previous build's entries survive a deploy |
| `maxAgeDays` | `30` | Entries not written for this long are removed, whether or not a page still uses them |

Example row:

```yaml
- insert:
    - id: static-cache
      name: '@perhydrol/dsh-static-cache'
      config:
        route: /__dsh-static-cache/sw.js
        prime: true
        maxCacheBytes: 134217728
```

## Invalidation

The page sends the client graph revision (`__DSH_BOOT__.rev`) and its own
`performance.timeOrigin` to the worker after load:

* a changed revision starts a new generation at the page's start time;
* entries written before that time belong to the previous build and are
  removed after `graceMinutes`, so a deploy does not break a tab that is still
  running the old build;
* entries written while loading the current page survive, so the first load
  after a deploy is not downloaded twice;
* a navigation to `/_auth/login` (logout or an expired session) deletes the
  whole cache;
* `maxAgeDays` and `maxCacheBytes` bound how long entries are kept and the total size.

Stable-path package assets (`/plugins/<pkg>/assets/*`) depend on the client
graph revision, which hashes bundle artifacts rather than those files. An
asset-only update that leaves every bundle byte-identical may therefore keep
the old bytes until `maxAgeDays`; rebuild the bundles or lower that bound when
assets change independently.

## Verify

In DevTools open one authenticated page twice:

* Network shows `/assets/*` and `/plugins/*` with size `(ServiceWorker)` and
  0 transferred bytes on the second load;
* `/api/*` still appears on the network;
* `await __DSH_STATIC_CACHE__.stats()` reports `entries`, `bytes`, `rev`,
  `hits`, `evicted`, `reconciled`, and `lastPrune`; entries and bytes count
  live cache entries after metadata reconciliation;
* a failed registration logs one `console.warn` instead of failing silently;
* logging out and returning to the login page leaves `caches.keys()` empty.

The first authenticated load after enabling the plugin downloads the assets
once more to fill the cache; later loads reuse it until the deployment changes.

## Remove

Delete the `static-cache` row from the profile's `cordis.patch.yml` and restart.
The worker stops being registered; cached bytes remain in the browser until the
login page is visited or the site's storage is cleared. While the plugin is
still enabled, `await __DSH_STATIC_CACHE__.purge()` clears it immediately.

## Security notes

* The worker route sits behind the deployment's reverse proxy and requires a
  session like every other DSH path.
* Only versioned static bytes are stored. The worker refuses HTML, API
  responses, SSE, redirected responses, range requests, and any response
  carrying `Set-Cookie`, so the cache holds no session state.
* Cache Storage entries live in the browser profile; a logged-out user on the
  same device cannot open the app, and the next login page visit purges the
  cache.

## Limitations

* Local latency for RPC calls is unchanged.
* The cache is per browser profile and per origin; incognito sessions start
  cold.
* Service workers require HTTPS or a loopback origin.
* Browser storage pressure or "clear site data" empties the cache; the next
  authenticated load refills it.

## Tests

```sh
cd experiments/public-auth/static-cache && node --test tests/*.test.js
```

The service-worker tests execute the real worker source in a VM against a fake
Cache Storage, covering generation changes, grace-pruning, logout purge,
priming, eviction, and streamed responses.
