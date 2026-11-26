# dsh-static-cache

English | [中文](README.zh.md)

Browser-side cache for DSH Web static assets, installed as an out-of-tree
profile plugin. It keeps the deployment's authentication untouched: the
service worker only stores bytes that an authenticated page already fetched
with its session cookie.

Storage requires `X-DSH-Upstream-Cache-Control` from the authentication proxy to declare a positive `max-age`, or a `no-cache` / `max-age=0` response carrying an `ETag` or `Last-Modified`. Missing policy and `no-store` are denied. `no-cache` entries are stored and revalidated on every use; `immutable` entries are reused without resource validation while fresh. Every cache hit still checks `/_auth/session` over the network. Logout requests purge the cache even without page navigation. Old cache generations are removed on worker activation. The default `prefixes` include `/font-replacement/` for the font replacement plugin: its hashed WOFF2 files are immutable, while its `no-cache` stylesheet is revalidated through its ETag.

## What it caches

| Path | Cached | Why |
|---|---|---|
| `/assets/*` (hashed JS, CSS, fonts, images) | yes, revalidated | DSH serves `no-cache` with an ETag |
| `/plugins/??...&rev=` (combo bundles, chunks, package assets) | yes | revisioned by DSH and `immutable` |
| `/font-replacement/*.woff2` | yes | hashed and `immutable` |
| `/font-replacement/fonts.css` | yes, revalidated | `no-cache` with an ETag |
| `/` (index) | no | carries per-peer boot injections |
| `/api/*` | no | session-scoped responses |
| `/plugins/events` (SSE) | no | long-lived stream |
| `/_auth/*`, `/connect` | no | authentication |

A `no-cache` entry becomes a cache hit only after the origin answers 304; a 200 replaces the stored bytes. An `immutable` entry is served directly while its `max-age` is fresh and is revalidated only after it expires. Cached delivery removes static round trips; API latency is unchanged.

## Install (container deployment)

The plugin ships built at `/opt/static-cache` in the image. Enable it once per profile:

```sh
docker compose --env-file server.env exec harness sh /opt/static-cache/enable.sh
docker compose --env-file server.env restart harness
```

The script performs the two steps the profile needs:

1. copies the built package (`package.json` and `dist/`) to `<profile>/node_modules/@perhydrol/dsh-static-cache` and records it under `dependencies` in `<profile>/package.json`;
2. appends an `insert` row for the plugin to the profile's `cordis.patch.yml` unless the row is already present.

Both steps are idempotent. The profile lives in the `data` volume, so they survive container recreation; rerun the script after restoring an older volume. The package is authored in TypeScript under `src/`; the image build compiles it to `dist/` and runs its tests before copying it.

## Configuration

The row's `config` accepts every field below; all are optional.

| Field | Default | Meaning |
|---|---|---|
| `route` | `/__dsh-static-cache/sw.js` | Path serving the worker script |
| `scope` | `/` | Worker scope; every prefix must live inside it |
| `prefixes` | `["/assets/", "/plugins/", "/font-replacement/"]` | Cacheable path prefixes |
| `exclude` | `["/plugins/events"]` | Exact paths that always hit the network |
| `prime` | `true` | Fetch and store the current page's assets after load |
| `concurrency` | `4` | Parallel prefetch requests |
| `maxCacheBytes` | 64 MiB | Whole-cache bound; least recent entries evict first |
| `maxEntryBytes` | 32 MiB | Larger responses are served but never stored |
| `graceMinutes` | `10` | How long a previous build's entries survive a deploy |
| `maxAgeDays` | `30` | Entries not written or revalidated for this long are removed |
| `revalidate` | `true` | Revalidate stale entries that carry an ETag or Last-Modified |

`revalidate: false` disables validator handling: `no-cache` and `max-age=0` responses are not stored, and stale entries that remain from an older deployment fall back to a full fetch. Positive `max-age` responses stay cacheable.

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
* `maxAgeDays` and `maxCacheBytes` bound how long entries are kept and the total size;
* a 304 revalidation refreshes the entry's `storedAt`, so an actively revalidated `no-cache` entry is not removed by age.

`maxAgeDays` remains a local retention bound. A 304 refreshes `storedAt`; a fresh `immutable` hit does not, so an entry used only through fresh hits can still be removed after this many days without a write or revalidation.

Stable-path package assets (`/plugins/<pkg>/assets/*`) depend on the client
graph revision, which hashes bundle artifacts rather than those files. An
asset-only update that leaves every bundle byte-identical may therefore keep
the old bytes until `maxAgeDays`; rebuild the bundles or lower that bound when
assets change independently.

## Verify

In DevTools open one authenticated page twice:

* on the second load, `/plugins/*` shows `(ServiceWorker)` and 0 asset bytes;
* `/assets/*` and `/font-replacement/fonts.css` show a 304 response and `(ServiceWorker)`, with the body served from Cache Storage;
* `/api/*` still appears on the network;
* `await __DSH_STATIC_CACHE__.stats()` reports `entries`, `bytes`, `rev`, `hits`, `misses`, `stored`, `evicted`, `reconciled`, `revalidated`, `dropped`, and `lastPrune`; `entries` and `bytes` count live cache entries after metadata reconciliation;
* a fresh `immutable` entry sends no `If-None-Match`; a `no-cache` entry does;
* a failed registration logs one `console.warn` instead of failing silently;
* logging out and returning to the login page leaves `caches.keys()` empty.

The first authenticated load after enabling the plugin downloads the assets
once more to fill the cache; later loads reuse them until the deployment changes.
`no-cache` assets keep requiring one conditional request per load.

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
* A `no-cache` entry is never replayed without a network validation. An
  `immutable` entry skips resource validation while fresh but still requires
  the `/_auth/session` probe.
* Cache Storage entries live in the browser profile; a logged-out user on the
  same device cannot open the app, and the next login page visit purges the
  cache.

## Limitations

* `no-cache` entries need one conditional round trip per use; the first use
  after a content change downloads the full body.
* If the proxy strips `ETag` or `Last-Modified`, `no-cache` responses are not
  stored because they cannot be validated.
* `maxAgeDays` can remove an `immutable` entry earlier than its origin
  `max-age`, because retention is a local bound.
* Local latency for RPC calls is unchanged.
* The cache is per browser profile and per origin; incognito sessions start
  cold.
* Service workers require HTTPS or a loopback origin.
* Browser storage pressure or "clear site data" empties the cache; the next
  authenticated load refills it.

## Tests

```sh
cd experiments/public-auth/static-cache && npm test
```

The test script builds the TypeScript sources into `dist/` and executes the
real worker source in a VM against a fake Cache Storage. It covers generation
changes, grace-pruning, logout purge, priming, eviction, streamed responses,
ETag revalidation, immutable reload behavior, and revalidation failures.
