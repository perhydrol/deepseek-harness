/**
 * Service worker: cache-first delivery for versioned DSH static assets.
 *
 * The worker only stores bytes that the authenticated page already fetched
 * with its session cookie. It never handles navigations' bodies, `/api`, the
 * SSE stream, or any cross-origin request. Cache hits require a successful
 * session check; storage requires the proxy's original upstream policy.
 *
 * Invalidation is generation-based: the page sends `init` with the client
 * graph revision (`__DSH_BOOT__.rev`) and its own `performance.timeOrigin`.
 * Entries written before that origin belong to a previous build and are
 * removed after a grace period; entries from the current page survived.
 */

/** Deployment policy embedded by the Host when it serves this script. */
interface EmbeddedConfig {
  prefixes: string[]
  exclude: string[]
  concurrency: number
  maxCacheBytes: number
  maxEntryBytes: number
  graceMs: number
  maxAgeMs: number
  revalidate: boolean
}

/** Persistent metadata stored beside the cached responses. */
interface Meta {
  format: 1
  rev: string | null
  generationStartedAt: number
  storedAt: Record<string, number>
  bytes: Record<string, number>
  lastPrune: number
}

/** Parsed upstream cache policy for one response. */
interface Policy {
  maxAge: number
  immutable: boolean
  noCache: boolean
  noStore: boolean
  etag: string | null
  lastModified: string | null
  validator: string | null
  admissible: boolean
}

/** Counters exposed through `__DSH_STATIC_CACHE__.stats()`. */
interface Stats {
  hits: number
  misses: number
  stored: number
  evicted: number
  reconciled: number
  revalidated: number
  dropped: number
  bytes: number
  lastError: string | null
}

/** Observable worker state returned to page messages. */
interface Snapshot {
  rev: string | null
  generationStartedAt: number
  entries: number
  bytes: number
  hits: number
  misses: number
  stored: number
  evicted: number
  reconciled: number
  revalidated: number
  dropped: number
  lastPrune: number
  lastError: string | null
}

const CACHE_NAME = 'dsh-static-v2'
const META_PATH = '/__dsh-static-cache-meta__'
const PRUNE_INTERVAL_MS = 60 * 60 * 1000

const EMBEDDED_CONFIG: EmbeddedConfig | null = /* dsh-static-cache:config */null

/** Fail-safe default when the Host served the raw source without a policy. */
const SAFE_CONFIG: EmbeddedConfig = {
  prefixes: [],
  exclude: [],
  concurrency: 4,
  maxCacheBytes: 64 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  graceMs: 10 * 60 * 1000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
  revalidate: true,
}

/**
 * The worker source runs as a classic script. This predicate narrows the
 * generic worker global to the service-worker scope without an unchecked cast.
 * @param value - Candidate global object.
 * @returns Whether `value` exposes the service-worker `clients` surface.
 */
function isServiceWorkerScope(value: unknown): value is ServiceWorkerGlobalScope {
  return typeof value === 'object' && value !== null && 'clients' in value
}

/**
 * @param value - Candidate global object.
 * @returns The narrowed service-worker scope.
 * @throws When the script is not running in a service worker.
 */
function serviceWorkerScope(value: unknown): ServiceWorkerGlobalScope {
  if (!isServiceWorkerScope(value)) throw new Error('static-cache: service worker scope expected')
  return value
}

const scope = serviceWorkerScope(self)
const config = EMBEDDED_CONFIG ?? SAFE_CONFIG
const META_URL = new URL(META_PATH, scope.location.origin).href

/** Paths that must never be stored, even under a misconfigured policy. */
const NEVER_CACHE = ['/api', '/_auth', '/connect']

let epoch = 0
let cachePromise: Promise<Cache> | null = null
let meta: Meta | null = null
let metaWrite: Promise<void> = Promise.resolve()
const stats: Stats = {
  hits: 0,
  misses: 0,
  stored: 0,
  evicted: 0,
  reconciled: 0,
  revalidated: 0,
  dropped: 0,
  bytes: 0,
  lastError: null,
}
const inflight = new Map<string, Promise<void>>()
const pending = new Set<Promise<unknown>>()

/**
 * @param task - Async metadata mutation that purge must wait for.
 * @returns The same task.
 */
function track<T>(task: Promise<T>): Promise<T> {
  pending.add(task)
  void task.then(() => pending.delete(task), () => pending.delete(task))
  return task
}

/** @returns The fixed cache, opened once. */
function openCache(): Promise<Cache> {
  cachePromise ??= caches.open(CACHE_NAME)
  return cachePromise
}

/** @returns An empty metadata record. */
function emptyMeta(): Meta {
  return { format: 1, rev: null, generationStartedAt: 0, storedAt: {}, bytes: {}, lastPrune: 0 }
}

/**
 * @param value - Candidate metadata map.
 * @returns Whether every value is a finite number.
 */
function isNumberRecord(value: unknown): value is Record<string, number> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.values(value).every(entry => typeof entry === 'number' && Number.isFinite(entry))
}

/**
 * @param value - Candidate generation stamp.
 * @param fallback - Value used when the stamp is not finite.
 * @returns A floored finite number.
 */
function finiteStamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
}

/**
 * @param raw - Parsed JSON metadata.
 * @returns A metadata record narrowed to the current format.
 */
function normalizeMeta(raw: unknown): Meta {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return emptyMeta()
  const value = raw as Record<string, unknown>
  return {
    format: 1,
    rev: typeof value.rev === 'string' ? value.rev : null,
    generationStartedAt: finiteStamp(value.generationStartedAt, 0),
    storedAt: isNumberRecord(value.storedAt) ? { ...value.storedAt } : {},
    bytes: isNumberRecord(value.bytes) ? { ...value.bytes } : {},
    lastPrune: finiteStamp(value.lastPrune, 0),
  }
}

/** @returns Cached metadata, read once per worker lifetime. */
async function loadMeta(): Promise<Meta> {
  if (meta !== null) return meta
  const cache = await openCache()
  let text: string | null = null
  try {
    const response = await cache.match(META_URL, { ignoreVary: true })
    if (response !== undefined) text = await response.text()
  } catch (error) {
    // A storage failure must not be mistaken for "no metadata": overwriting
    // the good record here would let the next prune delete the whole cache.
    stats.lastError = String(error)
    throw error
  }
  let parsed: unknown = null
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

/** @returns A promise that resolves once the snapshot has been written. */
function saveMeta(): Promise<void> {
  if (meta === null) return Promise.resolve()
  const text = JSON.stringify(meta)
  metaWrite = metaWrite.then(async () => {
    const cache = await openCache()
    await cache.put(META_URL, new Response(text, { headers: { 'content-type': 'application/json' } }))
  }).catch((error) => { stats.lastError = String(error) })
  return metaWrite
}

/**
 * Parse the proxy's preserved upstream policy.
 * @param response - Stored or freshly fetched response.
 * @returns Parsed policy including its validator and admission decision.
 */
function parsePolicy(response: Response): Policy {
  const raw = response.headers.get('x-dsh-upstream-cache-control')
  const hasPolicy = raw !== null && raw.trim() !== ''
  const directives = hasPolicy ? raw.toLowerCase().split(',').map(value => value.trim()) : []
  const noStore = directives.some(value => /^no-store(?:=|$)/.test(value))
  const noCache = directives.some(value => /^no-cache(?:=|$)/.test(value))
  const immutable = directives.some(value => /^immutable(?:=|$)/.test(value))
  let maxAge = 0
  for (const directive of directives) {
    const match = /^max-age=(\d+)$/.exec(directive)
    if (match !== null) {
      maxAge = Number(match[1] ?? 0)
      break
    }
  }
  if (noCache || noStore) maxAge = 0
  const etag = response.headers.get('etag')
  const lastModified = response.headers.get('last-modified')
  const validator = etag ?? lastModified
  return {
    maxAge,
    immutable,
    noCache,
    noStore,
    etag,
    lastModified,
    validator,
    admissible: hasPolicy && !noStore && (maxAge > 0 || validator !== null),
  }
}

/**
 * Apply admission safety checks to a freshly fetched response.
 * @param request - Request that produced the response.
 * @param response - Candidate response.
 * @returns Parsed policy with `admissible` narrowed by the safety checks.
 */
function admission(request: Request, response: Response): Policy {
  const policy = parsePolicy(response)
  const refuse = (): Policy => ({ ...policy, admissible: false })
  if (!response.ok) return refuse()
  if (response.type === 'opaque' || response.type === 'opaqueredirect' || response.type === 'error') return refuse()
  if (response.redirected) return refuse()
  if (response.headers.has('set-cookie')) return refuse()
  if (request.headers.has('range')) return refuse()
  if (!config.revalidate && policy.maxAge === 0) return refuse()
  const length = response.headers.get('content-length')
  if (length !== null) {
    const declared = Number(length)
    if (Number.isFinite(declared) && declared > config.maxEntryBytes) return refuse()
  }
  return policy
}

/**
 * @param policy - Parsed policy.
 * @param storedAt - Local write timestamp.
 * @returns Whether the stored bytes may be served without contacting the origin.
 */
function isFresh(policy: Policy, storedAt: number): boolean {
  return policy.admissible && policy.maxAge > 0 && Date.now() - storedAt < policy.maxAge * 1000
}

/**
 * @param request - Fetch-event request.
 * @returns Whether the request asks caches to revalidate fresh responses.
 */
function wantsRevalidation(request: Request): boolean {
  if (request.cache === 'reload' || request.cache === 'no-cache') return true
  const control = request.headers.get('cache-control')
  return control !== null && /(?:^|,)\s*(?:no-cache|max-age=0)\s*(?:,|$)/i.test(control)
}

/** @returns The authenticated session probe for a cache hit. */
function sessionRequest(): Request {
  return new Request(new URL('/_auth/session', scope.location.origin), {
    credentials: 'same-origin',
    cache: 'no-store',
  })
}

/**
 * @param request - Original asset request.
 * @param policy - Stored policy carrying the validator.
 * @returns A conditional GET for the same URL.
 */
function conditionalRequest(request: Request, policy: Policy): Request {
  const headers = new Headers()
  if (policy.etag !== null) headers.set('if-none-match', policy.etag)
  else if (policy.lastModified !== null) headers.set('if-modified-since', policy.lastModified)
  return new Request(request.url, {
    method: 'GET',
    headers,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'follow',
    mode: 'same-origin',
  })
}

/**
 * @param url - Same-origin URL.
 * @returns Whether the worker may store and serve this path.
 */
function allowed(url: URL): boolean {
  const path = url.pathname
  if (path === '/' || path === '/plugins/events') return false
  if (NEVER_CACHE.some(prefix => path === prefix || path.startsWith(`${prefix}/`))) return false
  if (config.exclude.includes(path)) return false
  return config.prefixes.some(prefix => path.startsWith(prefix))
}

/**
 * Evict least recently stored entries until the incoming response fits.
 * @param state - Current metadata.
 * @param incoming - Size of the response about to be stored.
 * @returns Nothing.
 */
async function enforceLimits(state: Meta, incoming: number): Promise<void> {
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
 * Remove one entry from storage and metadata.
 * @param state - Current metadata.
 * @param url - Entry cache key.
 * @param generation - Purge generation observed before the decision to drop.
 * @returns Nothing.
 */
async function dropEntry(state: Meta, url: string, generation: number): Promise<void> {
  try {
    if (generation !== epoch) return
    if (state.storedAt[url] === undefined && state.bytes[url] === undefined) return
    const cache = await openCache()
    await cache.delete(url)
    if (generation !== epoch) return
    stats.bytes = Math.max(0, stats.bytes - (state.bytes[url] ?? 0))
    delete state.storedAt[url]
    delete state.bytes[url]
    stats.dropped += 1
    await saveMeta()
  } catch (error) {
    stats.lastError = String(error)
  }
}

/**
 * Store one response and record it in the metadata generation.
 * @param request - Fetch request used as the cache key.
 * @param response - Response body to store.
 * @param generation - Purge generation observed when the fetch started.
 * @returns A promise that settles the store attempt.
 */
function store(request: Request, response: Response, generation: number): Promise<void> {
  const key = request.url
  const running = inflight.get(key)
  if (running !== undefined) return running
  const task = (async () => {
    try {
      if (generation !== epoch) return
      const cache = await openCache()
      const state = await loadMeta()
      const declared = response.headers.get('content-length')
      let size = declared !== null && Number(declared) > 0 ? Number(declared) : 0
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
      if (generation !== epoch) return
      const previousSize = state.bytes[key] ?? 0
      if (state.storedAt[key] !== undefined) {
        stats.bytes = Math.max(0, stats.bytes - previousSize)
        delete state.storedAt[key]
        delete state.bytes[key]
      }
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
 * @param force - Ignore the hourly rate limit.
 * @returns Nothing.
 */
async function prune(force: boolean): Promise<void> {
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
    stats.bytes = Math.max(0, stats.bytes - (state.bytes[key.url] ?? 0))
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

/** @returns Nothing once every owned cache is gone. */
async function purge(): Promise<void> {
  // Let an in-flight metadata write finish before deleting; a later write
  // would otherwise recreate an empty cache generation.
  epoch += 1
  await Promise.all([...inflight.values(), ...pending])
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
  stats.revalidated = 0
  stats.dropped = 0
  stats.bytes = 0
}

/** @returns Observable worker state for `__DSH_STATIC_CACHE__.stats()`. */
function snapshot(): Snapshot {
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
    revalidated: stats.revalidated,
    dropped: stats.dropped,
    lastPrune: state.lastPrune,
    lastError: stats.lastError,
  }
}

/**
 * @param response - Response to inspect.
 * @param requestUrl - URL of the request that produced it.
 * @returns Whether this response landed on the login page.
 */
function isLoginNavigation(response: Response, requestUrl: string): boolean {
  const target = response.redirected ? response.url : response.headers.get('location')
  if (target === null || target === '') return false
  try {
    return new URL(target, requestUrl).pathname === '/_auth/login'
  } catch {
    return false
  }
}

/**
 * @param request - Navigation request.
 * @returns The network response, purging the cache when the session ended.
 */
async function navigate(request: Request): Promise<Response> {
  // A navigation that already targets the login page is a logout or an
  // expired session; the redirect case is handled from the response below.
  if (new URL(request.url).pathname === '/_auth/login') await purge()
  const response = await fetch(request)
  if (isLoginNavigation(response, request.url)) await purge()
  return response
}

/**
 * Fetch a missing response and store it when its policy admits the bytes.
 * @param event - Fetch event carrying the waitUntil lifetime.
 * @param request - Asset request.
 * @param generation - Purge generation observed before the fetch.
 * @returns The network response.
 */
async function fetchAndStore(event: FetchEvent, request: Request, generation: number): Promise<Response> {
  stats.misses += 1
  const response = await fetch(request)
  if (generation === epoch) {
    const policy = admission(request, response)
    if (policy.admissible) {
      event.waitUntil(store(request, response.clone(), generation))
    } else if (response.status === 401 || isLoginNavigation(response, request.url)) {
      await purge()
    }
  }
  return response
}

/**
 * Revalidate one stale entry with its validator.
 * @param event - Fetch event carrying the waitUntil lifetime.
 * @param request - Asset request.
 * @param hit - Stored response.
 * @param policy - Policy parsed from the stored response.
 * @param state - Current metadata.
 * @param generation - Purge generation observed before the fetch.
 * @returns Either the stored bytes, a replacement response, or a network failure response.
 */
async function revalidate(
  event: FetchEvent,
  request: Request,
  hit: Response,
  policy: Policy,
  state: Meta,
  generation: number,
): Promise<Response> {
  const [session, response] = await Promise.all([
    fetch(sessionRequest()),
    fetch(conditionalRequest(request, policy)),
  ])
  if (!session.ok || generation !== epoch) {
    await purge()
    return fetch(request)
  }
  if (response.status === 304) {
    state.storedAt[request.url] = Date.now()
    stats.revalidated += 1
    stats.hits += 1
    event.waitUntil(saveMeta())
    return hit
  }
  if (isLoginNavigation(response, request.url) || response.status === 401) {
    await purge()
    return response
  }
  stats.misses += 1
  if (generation === epoch) {
    const next = admission(request, response)
    if (next.admissible) {
      event.waitUntil(store(request, response.clone(), generation))
    } else {
      event.waitUntil(track(dropEntry(state, request.url, generation)))
    }
  }
  return response
}

/**
 * @param event - Fetch event carrying the waitUntil lifetime.
 * @param request - Asset request.
 * @returns A response from Cache Storage or the network.
 */
async function serveAsset(event: FetchEvent, request: Request): Promise<Response> {
  // A partial request needs a 206 from the origin; a stored full response
  // cannot satisfy it and must not be substituted.
  if (request.headers.has('range')) {
    stats.misses += 1
    return fetch(request)
  }
  const generation = epoch
  const cache = await openCache()
  const hit = await cache.match(request, { ignoreVary: true })
  if (hit === undefined) return fetchAndStore(event, request, generation)
  let state: Meta
  try {
    state = await loadMeta()
  } catch (error) {
    stats.lastError = String(error)
    return fetch(request)
  }
  const policy = parsePolicy(hit)
  const storedAt = state.storedAt[request.url] ?? 0
  if (isFresh(policy, storedAt) && (!wantsRevalidation(request) || policy.immutable)) {
    const session = await fetch(sessionRequest())
    if (!session.ok || generation !== epoch) {
      await purge()
      return fetch(request)
    }
    stats.hits += 1
    return hit
  }
  if (config.revalidate && policy.admissible && policy.validator !== null) {
    return revalidate(event, request, hit, policy, state, generation)
  }
  stats.misses += 1
  const response = await fetch(request)
  if (generation === epoch) {
    const next = admission(request, response)
    if (next.admissible) {
      event.waitUntil(store(request, response.clone(), generation))
    } else if (response.status === 401 || isLoginNavigation(response, request.url)) {
      await purge()
    } else {
      event.waitUntil(track(dropEntry(state, request.url, generation)))
    }
  }
  return response
}

/**
 * @param items - Items to process.
 * @param limit - Maximum parallel workers.
 * @param worker - Per-item task.
 * @returns Nothing once every item is processed.
 */
async function mapLimit<T>(items: readonly T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let index = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index]
      index += 1
      if (item !== undefined) await worker(item)
    }
  })
  await Promise.all(runners)
}

/**
 * Fetch missing entries with bounded concurrency.
 * @param rawUrls - Document-relative URLs collected by the page.
 * @param reply - Message reply callback.
 * @returns Nothing.
 */
async function prime(rawUrls: unknown, reply: (value: unknown) => void): Promise<void> {
  const urls = Array.isArray(rawUrls)
    ? [...new Set(rawUrls.filter((item): item is string => typeof item === 'string'))]
    : []
  const generation = epoch
  const result = { total: urls.length, fetched: 0, skipped: 0, failed: 0 }
  const cache = await openCache()
  await mapLimit(urls, config.concurrency, async (path) => {
    let url: URL
    try {
      url = new URL(path, scope.location.origin)
    } catch {
      result.skipped += 1
      return
    }
    if (url.origin !== scope.location.origin || !allowed(url)) {
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
      if (generation !== epoch || !admission(request, response).admissible) {
        result.skipped += 1
        return
      }
      await store(request, response.clone(), generation)
      result.fetched += 1
    } catch (error) {
      stats.lastError = String(error)
      result.failed += 1
    }
  })
  await saveMeta()
  reply({ ...snapshot(), ...result })
}

scope.addEventListener('install', () => {
  void scope.skipWaiting()
})

scope.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name !== CACHE_NAME && name.startsWith('dsh-static-')) await caches.delete(name)
    }
    await scope.clients.claim()
  })())
})

/**
 * Run one message task and keep a storage failure observable instead of
 * rejecting into the worker's void.
 * @param task - Task to settle.
 * @param reply - Message reply callback.
 * @returns Nothing.
 */
async function settle(task: Promise<unknown>, reply: (value: unknown) => void): Promise<void> {
  try {
    await task
  } catch (error) {
    stats.lastError = String(error)
    reply(snapshot())
  }
}

scope.addEventListener('fetch', (event: FetchEvent) => {
  const request = event.request
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return
  }
  if (url.origin !== scope.location.origin) return
  if (request.method === 'POST' && url.pathname === '/_auth/logout') {
    event.respondWith((async () => {
      try {
        return await fetch(request)
      } finally {
        await purge()
      }
    })())
    return
  }
  if (request.method !== 'GET') return
  if (request.mode === 'navigate') {
    event.respondWith(navigate(request))
    return
  }
  if (!allowed(url)) return
  event.respondWith(serveAsset(event, request))
})

scope.addEventListener('message', (event: ExtendableMessageEvent) => {
  const data = event.data as unknown
  if (typeof data !== 'object' || data === null) return
  const record = data as Record<string, unknown>
  /** @param value - Reply payload. */
  const reply = (value: unknown): void => {
    const port = event.ports[0]
    if (port !== undefined) port.postMessage(value)
  }
  if (record.type === 'init') {
    event.waitUntil(settle((async () => {
      const state = await loadMeta()
      const origin = Number(record.timeOrigin)
      const startedAt = Number.isFinite(origin) && origin > 0 ? Math.floor(origin) : Date.now()
      const rev = typeof record.rev === 'string' && record.rev !== '' ? record.rev : null
      const changed = rev !== null && rev !== state.rev
      if (changed) {
        state.rev = rev
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
  if (record.type === 'prime') {
    event.waitUntil(settle(prime(record.urls, reply), reply))
    return
  }
  if (record.type === 'stats') {
    event.waitUntil(settle((async () => {
      await loadMeta()
      reply(snapshot())
    })(), reply))
    return
  }
  if (record.type === 'prune') {
    event.waitUntil(settle((async () => {
      await loadMeta()
      await prune(true)
      reply(snapshot())
    })(), reply))
    return
  }
  if (record.type === 'purge') {
    event.waitUntil(settle((async () => {
      await purge()
      reply(snapshot())
    })(), reply))
  }
})
