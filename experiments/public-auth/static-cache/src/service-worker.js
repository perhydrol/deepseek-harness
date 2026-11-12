/**
 * Service worker: cache-first delivery for versioned DSH static assets.
 *
 * The worker only stores bytes that the authenticated page already fetched
 * with its session cookie. It never handles navigations' bodies, `/api`, the
 * SSE stream, or any cross-origin request, so the deployment's authentication
 * gate stays the only way to obtain these bytes over the network.
 *
 * Invalidation is generation-based: the page sends `init` with the client
 * graph revision (`__DSH_BOOT__.rev`) and its own `performance.timeOrigin`.
 * Entries written before that origin belong to a previous build and are
 * removed after a grace period; entries from the current page survived.
 */

const CACHE_NAME = 'dsh-static-v1'
const META_PATH = '/__dsh-static-cache-meta__'
const META_URL = new URL(META_PATH, self.location.origin).href
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

/**
 * Deployment policy injected by the Host when it serves this script. Page
 * messages cannot change it: a same-origin script must not be able to widen
 * the cache to `/api` or drop the SSE exclusion.
 */
const EMBEDDED_CONFIG = /* dsh-static-cache:config */null

/** Fail-safe default when the Host served the raw source without a policy. */
const SAFE_CONFIG = {
  prefixes: [],
  exclude: [],
  concurrency: 4,
  maxCacheBytes: 64 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  graceMs: 10 * 60 * 1000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
}

const config = EMBEDDED_CONFIG ?? SAFE_CONFIG

/** Paths that must never be stored, even under a misconfigured policy. */
const NEVER_CACHE = ['/api', '/_auth', '/connect']

let cachePromise = null
let meta = null
let metaWrite = Promise.resolve()
const stats = { hits: 0, misses: 0, stored: 0, evicted: 0, reconciled: 0, bytes: 0, lastError: null }
const inflight = new Map()

/** @returns {Promise<Cache>} The fixed cache, opened once. */
function openCache() {
  cachePromise ??= caches.open(CACHE_NAME)
  return cachePromise
}

/** @returns {object} Empty metadata record. */
function emptyMeta() {
  return { format: 1, rev: null, generationStartedAt: 0, storedAt: {}, bytes: {}, lastPrune: 0 }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, number>}
 */
function isNumberRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(entry => Number.isFinite(entry))
}

/**
 * @param {unknown} raw
 * @returns {object} A metadata record narrowed to the current format.
 */
function normalizeMeta(raw) {
  if (typeof raw !== 'object' || raw === null) return emptyMeta()
  const value = /** @type {Record<string, unknown>} */ (raw)
  return {
    format: 1,
    rev: typeof value.rev === 'string' ? value.rev : null,
    generationStartedAt: Number.isFinite(value.generationStartedAt) ? Math.floor(/** @type {number} */ (value.generationStartedAt)) : 0,
    storedAt: isNumberRecord(value.storedAt) ? { ...value.storedAt } : {},
    bytes: isNumberRecord(value.bytes) ? { ...value.bytes } : {},
    lastPrune: Number.isFinite(value.lastPrune) ? Math.floor(/** @type {number} */ (value.lastPrune)) : 0,
  }
}

/** @returns {Promise<object>} Cached metadata, read once per worker lifetime. */
async function loadMeta() {
  if (meta !== null) return meta
  const cache = await openCache()
  let text = null
  try {
    const response = await cache.match(META_URL, { ignoreVary: true })
    if (response !== undefined) text = await response.text()
  } catch (error) {
    // A storage failure must not be mistaken for "no metadata": overwriting
    // the good record here would let the next prune delete the whole cache.
    stats.lastError = String(error)
    throw error
  }
  let parsed = null
  if (text !== null) {
    try {
      parsed = JSON.parse(text)
    } catch (error) {
      // A corrupt record is recoverable; the cache entries are reconciled later.
      stats.lastError = String(error)
    }
  }
  meta = normalizeMeta(parsed)
  stats.bytes = Object.values(meta.bytes).reduce((sum, size) => sum + size, 0)
  return meta
}

/** @returns {Promise<void>} Resolves once the snapshot has been written. */
function saveMeta() {
  if (meta === null) return Promise.resolve()
  const text = JSON.stringify(meta)
  metaWrite = metaWrite.then(async () => {
    const cache = await openCache()
    await cache.put(META_URL, new Response(text, { headers: { 'content-type': 'application/json' } }))
  }).catch((error) => { stats.lastError = String(error) })
  return metaWrite
}

/**
 * @param {URL} url
 * @returns {boolean} Whether the worker may store and serve this path.
 */
function allowed(url) {
  const path = url.pathname
  if (path === '/' || path === '/plugins/events') return false
  if (NEVER_CACHE.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return false
  if (config.exclude.includes(path)) return false
  return config.prefixes.some(prefix => path.startsWith(prefix))
}

/**
 * @param {Request} request
 * @param {Response} response
 * @returns {boolean} Whether the response is safe and small enough to store.
 */
function shouldStore(request, response) {
  if (!response.ok) return false
  if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.type === 'error') return false
  if (response.redirected) return false
  if (response.headers.has('set-cookie')) return false
  if (request.headers.has('range')) return false
  const size = Number(response.headers.get('content-length'))
  return !Number.isFinite(size) || size <= config.maxEntryBytes
}

/**
 * Evict least recently stored entries until the incoming response fits.
 * @param {object} state Current metadata.
 * @param {number} incoming Size of the response about to be stored.
 * @returns {Promise<void>}
 */
async function enforceLimits(state, incoming) {
  let total = stats.bytes + incoming
  if (total <= config.maxCacheBytes) return
  const cache = await openCache()
  const oldest = Object.entries(state.storedAt).sort((left, right) => left[1] - right[1])
  for (const [url] of oldest) {
    if (total <= config.maxCacheBytes) break
    await cache.delete(url)
    total -= state.bytes[url] ?? 0
    stats.bytes = Math.max(0, stats.bytes - (state.bytes[url] ?? 0))
    stats.evicted += 1
    delete state.storedAt[url]
    delete state.bytes[url]
  }
}

/**
 * Store one response and record it in the metadata generation.
 * @param {Request} request Fetch request used as the cache key.
 * @param {Response} response Response body to store.
 * @returns {Promise<void>}
 */
function store(request, response) {
  const key = request.url
  const running = inflight.get(key)
  if (running !== undefined) return running
  const task = (async () => {
    try {
      const cache = await openCache()
      const state = await loadMeta()
      // A record without a live entry (quota eviction, a failed meta write, or
      // a prior partial prune) must not block storing the bytes again.
      const previousSize = state.bytes[key] ?? 0
      if (state.storedAt[key] !== undefined) {
        stats.bytes = Math.max(0, stats.bytes - previousSize)
        delete state.storedAt[key]
        delete state.bytes[key]
      }
      const declared = Number(response.headers.get('content-length'))
      let size = Number.isFinite(declared) && declared > 0 ? declared : 0
      let stored = response
      if (size === 0) {
        // DSH streams gzip responses chunked, so the decoded body length is the
        // only available size signal; it also drives the eviction accounting.
        const body = await response.arrayBuffer()
        size = body.byteLength
        stored = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
      }
      if (size > config.maxEntryBytes) return
      await enforceLimits(state, size)
      await cache.put(request, stored)
      state.storedAt[key] = Date.now()
      state.bytes[key] = size
      stats.stored += 1
      stats.bytes += size
      await saveMeta()
    } catch (error) {
      stats.lastError = String(error)
    } finally {
      inflight.delete(key)
    }
  })()
  inflight.set(key, task)
  return task
}

/**
 * Remove entries from previous builds after the grace period, plus entries
 * older than the configured maximum age.
 * @param {boolean} force Ignore the hourly rate limit.
 * @returns {Promise<void>}
 */
async function prune(force) {
  const state = await loadMeta()
  const now = Date.now()
  if (!force && now - state.lastPrune < PRUNE_INTERVAL_MS) return
  state.lastPrune = now
  const cache = await openCache()
  const keys = await cache.keys()
  const present = new Set(keys.map(key => key.url))
  const oldGeneration = state.generationStartedAt > 0 && now - state.generationStartedAt > config.graceMs
    ? state.generationStartedAt
    : -1
  const expiry = now - config.maxAgeMs
  for (const key of keys) {
    if (key.url === META_URL) continue
    const storedAt = state.storedAt[key.url]
    if (storedAt !== undefined && storedAt >= oldGeneration && storedAt >= expiry) continue
    await cache.delete(key)
    stats.bytes -= state.bytes[key.url] ?? 0
    stats.evicted += 1
    delete state.storedAt[key.url]
    delete state.bytes[key.url]
  }
  // Records whose bytes are gone would otherwise report phantom size and keep
  // the URL in a permanent miss/early-return state.
  for (const url of Object.keys(state.storedAt)) {
    if (present.has(url)) continue
    stats.bytes = Math.max(0, stats.bytes - (state.bytes[url] ?? 0))
    stats.reconciled += 1
    delete state.storedAt[url]
    delete state.bytes[url]
  }
  await saveMeta()
}

/** @param {Request} request @returns {Promise<void>} */
async function purge() {
  // Let an in-flight metadata write finish before deleting; a later write
  // would otherwise recreate an empty cache generation.
  await metaWrite
  for (const name of await caches.keys()) {
    if (name === CACHE_NAME || name.startsWith('dsh-static-')) await caches.delete(name)
  }
  cachePromise = null
  meta = null
  stats.hits = 0
  stats.misses = 0
  stats.stored = 0
  stats.evicted = 0
  stats.reconciled = 0
  stats.bytes = 0
}

/** @returns {object} Observable worker state for `__DSH_STATIC_CACHE__.stats()`. */
function snapshot() {
  const state = meta ?? emptyMeta()
  return {
    rev: state.rev,
    generationStartedAt: state.generationStartedAt,
    entries: Object.keys(state.storedAt).length,
    bytes: stats.bytes,
    hits: stats.hits,
    misses: stats.misses,
    stored: stats.stored,
    evicted: stats.evicted,
    reconciled: stats.reconciled,
    lastPrune: state.lastPrune,
    lastError: stats.lastError,
  }
}

/**
 * @param {Response} response
 * @param {string} requestUrl
 * @returns {boolean} Whether this navigation landed on the login page.
 */
function isLoginNavigation(response, requestUrl) {
  const target = response.redirected ? response.url : response.headers.get('location')
  if (target === null || target === '') return false
  try {
    return new URL(target, requestUrl).pathname === '/_auth/login'
  } catch {
    return false
  }
}

/** @param {Request} request @returns {Promise<Response>} */
async function navigate(request) {
  // A navigation that already targets the login page is a logout or an
  // expired session; the redirect case is handled from the response below.
  if (new URL(request.url).pathname === '/_auth/login') await purge()
  const response = await fetch(request)
  if (isLoginNavigation(response, request.url)) await purge()
  return response
}

/** @param {FetchEvent} event @param {Request} request @returns {Promise<Response>} */
async function serveAsset(event, request) {
  // A partial request needs a 206 from the origin; a stored full response
  // cannot satisfy it and must not be substituted.
  if (request.headers.has('range')) {
    stats.misses += 1
    return fetch(request)
  }
  const cache = await openCache()
  const hit = await cache.match(request, { ignoreVary: true })
  if (hit !== undefined) {
    stats.hits += 1
    return hit
  }
  stats.misses += 1
  const response = await fetch(request)
  if (shouldStore(request, response)) event.waitUntil(store(request, response.clone()))
  return response
}

/**
 * @param {unknown[]} items
 * @param {number} limit
 * @param {(item: unknown) => Promise<void>} worker
 * @returns {Promise<void>}
 */
async function mapLimit(items, limit, worker) {
  let index = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) await worker(items[index++])
  })
  await Promise.all(runners)
}

/**
 * Fetch missing entries with bounded concurrency.
 * @param {unknown} rawUrls
 * @param {(value: unknown) => void} reply
 * @returns {Promise<void>}
 */
async function prime(rawUrls, reply) {
  const urls = Array.isArray(rawUrls) ? [...new Set(rawUrls.filter(item => typeof item === 'string'))] : []
  const result = { total: urls.length, fetched: 0, skipped: 0, failed: 0 }
  const cache = await openCache()
  await mapLimit(urls, config.concurrency, async (path) => {
    let url
    try {
      url = new URL(/** @type {string} */ (path), self.location.origin)
    } catch {
      result.skipped += 1
      return
    }
    if (url.origin !== self.location.origin || !allowed(url)) {
      result.skipped += 1
      return
    }
    const request = new Request(url.href, { credentials: 'same-origin' })
    if (await cache.match(request, { ignoreVary: true }) !== undefined) {
      result.skipped += 1
      return
    }
    try {
      const response = await fetch(request)
      if (!shouldStore(request, response)) {
        result.skipped += 1
        return
      }
      await store(request, response.clone())
      result.fetched += 1
    } catch (error) {
      stats.lastError = String(error)
      result.failed += 1
    }
  })
  await saveMeta()
  reply({ ...snapshot(), ...result })
}

self.addEventListener('install', () => {
  void self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE_NAME && name.startsWith('dsh-static-')) await caches.delete(name)
    }
    await self.clients.claim()
  })())
})

/**
 * Run one message task and keep a storage failure observable instead of
 * rejecting into the worker's void.
 * @param {Promise<unknown>} task
 * @param {(value: unknown) => void} reply
 * @returns {Promise<void>}
 */
async function settle(task, reply) {
  try {
    await task
  } catch (error) {
    stats.lastError = String(error)
    reply(snapshot())
  }
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  let url
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (url.origin !== self.location.origin) return
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request))
    return
  }
  if (!allowed(url)) return
  event.respondWith(serveAsset(event, request))
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (typeof data !== 'object' || data === null) return
  /** @param {unknown} value */
  const reply = (value) => {
    const port = event.ports && event.ports[0]
    if (port !== undefined) port.postMessage(value)
  }
  if (data.type === 'init') {
    event.waitUntil(settle((async () => {
      const state = await loadMeta()
      const origin = Number(data.timeOrigin)
      const startedAt = Number.isFinite(origin) && origin > 0 ? Math.floor(origin) : Date.now()
      const changed = typeof data.rev === 'string' && data.rev !== '' && data.rev !== state.rev
      if (changed) {
        state.rev = data.rev
        state.generationStartedAt = startedAt
      } else if (state.generationStartedAt === 0) {
        state.generationStartedAt = startedAt
      }
      await saveMeta()
      await prune(changed)
      reply(snapshot())
    })(), reply))
    return
  }
  if (data.type === 'prime') {
    event.waitUntil(settle(prime(data.urls, reply), reply))
    return
  }
  if (data.type === 'stats') {
    event.waitUntil(settle((async () => {
      await loadMeta()
      reply(snapshot())
    })(), reply))
    return
  }
  if (data.type === 'prune') {
    event.waitUntil(settle((async () => {
      await loadMeta()
      await prune(true)
      reply(snapshot())
    })(), reply))
    return
  }
  if (data.type === 'purge') {
    event.waitUntil(settle((async () => {
      await purge()
      reply(snapshot())
    })(), reply))
  }
})
