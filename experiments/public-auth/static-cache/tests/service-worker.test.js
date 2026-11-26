import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorker, workerConfig } from './harness.js'

const ASSET_A = 'https://dsh.test/assets/index-abcdef12.js'
const ASSET_B = 'https://dsh.test/assets/vendor-12345678.js'
const META = '/__dsh-static-cache-meta__'

test('rejects missing and forbidden upstream cache policies', async () => {
  for (const policy of [null, '', 'no-store', 'no-cache', 'public, max-age=0']) {
    const worker = createWorker({ fetch: async () => new Response('private-value', { headers: {
      'cache-control': 'no-store',
      ...(policy === null ? {} : { 'x-dsh-upstream-cache-control': policy }),
    } }) })
    await worker.fetchEvent(new Request(ASSET_A))
    assert.equal(assetKeys(worker).length, 0, String(policy))
  }
})

const assetKeys = worker => [...worker.caches.entries('dsh-static-v2').keys()].filter(key => !key.includes(META))

/** @param {ReturnType<typeof createWorker>} worker @param {{ rev?: string, timeOrigin?: number }} [overrides] */
const init = (worker, overrides = {}) => worker.message({
  type: 'init',
  rev: overrides.rev ?? 'r1',
  timeOrigin: overrides.timeOrigin ?? worker.clock.now,
})

/**
 * Fetch implementation with one validator per URL and an optional session hook.
 * @param {{ body?: string, etag?: string, policy?: string, session?: () => Response }} [options]
 */
function etagFetch(options = {}) {
  const body = options.body ?? 'asset-v1'
  const etag = options.etag ?? '"v1"'
  const policy = options.policy ?? 'no-cache'
  return async (request) => {
    if (new URL(request.url).pathname === '/_auth/session') {
      return options.session?.() ?? new Response('{}')
    }
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag, 'x-dsh-upstream-cache-control': policy } })
    }
    return new Response(body, { headers: {
      etag,
      'x-dsh-upstream-cache-control': policy,
      'content-length': String(body.length),
    } })
  }
}

/**
 * @param {ReturnType<typeof createWorker>} worker
 * @returns {Request[]} Requests carrying a validator.
 */
const conditionalRequests = worker => worker.requests.filter(request => request.headers.has('if-none-match'))

test('serves an asset from cache on the second request', async () => {
  const worker = createWorker()
  await init(worker)
  const first = await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(first.handled, true)
  assert.equal(await first.response.text(), `body:${ASSET_A}`)
  const second = await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(await second.response.text(), `body:${ASSET_A}`)
  assert.equal(worker.calls.length, 1)
})

test('leaves API, SSE, cross-origin, and non-GET requests alone', async () => {
  const worker = createWorker()
  await init(worker)
  for (const request of [
    new Request('https://dsh.test/api/session/list'),
    new Request('https://dsh.test/plugins/events'),
    new Request('https://other.test/assets/index-abcdef12.js'),
    new Request('https://dsh.test/assets/index-abcdef12.js', { method: 'POST' }),
    new Request('https://dsh.test/manifest.webmanifest'),
  ]) {
    const result = await worker.fetchEvent(request)
    assert.equal(result.handled, false)
  }
})

test('ignores policy fields sent by the page', async () => {
  const worker = createWorker()
  await worker.message({
    type: 'init',
    rev: 'r1',
    timeOrigin: worker.clock.now,
    config: { prefixes: ['/api/'], exclude: [] },
  })
  assert.equal((await worker.fetchEvent(new Request('https://dsh.test/api/session/list'))).handled, false)
  assert.equal((await worker.fetchEvent(new Request('https://dsh.test/plugins/events'))).handled, false)
})

test('keeps API and SSE out even when the embedded policy names them', async () => {
  const worker = createWorker({ config: workerConfig({ prefixes: ['/api/'], exclude: [] }) })
  await init(worker)
  assert.equal((await worker.fetchEvent(new Request('https://dsh.test/api/session/list'))).handled, false)
  assert.equal((await worker.fetchEvent(new Request('https://dsh.test/plugins/events'))).handled, false)
})

test('page messages cannot widen a narrow embedded policy', async () => {
  const worker = createWorker({ config: workerConfig({ prefixes: ['/assets/'] }) })
  await worker.message({
    type: 'init',
    rev: 'r1',
    timeOrigin: worker.clock.now,
    config: { prefixes: ['/plugins/'], exclude: [] },
  })
  assert.equal(
    (await worker.fetchEvent(new Request('https://dsh.test/plugins/a/client.js'))).handled,
    false,
  )
})

test('keeps previous-generation entries during the grace period', async () => {
  const worker = createWorker({ now: 1_000 })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))

  worker.clock.now = 2_000
  await init(worker, { rev: 'r2', timeOrigin: 2_000 })
  await worker.message({ type: 'prune' })

  assert.equal(assetKeys(worker).length, 1)
})

test('removes previous-generation entries after the grace period', async () => {
  const worker = createWorker({ now: 1_000 })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))

  worker.clock.now = 2_000
  await init(worker, { rev: 'r2', timeOrigin: 2_000 })
  await worker.fetchEvent(new Request(ASSET_B))

  worker.clock.now = 2_000 + 600_001
  const snapshot = await worker.message({ type: 'prune' })

  assert.equal(snapshot.rev, 'r2')
  assert.deepEqual(assetKeys(worker), [ASSET_B])
})

test('keeps entries written by the current page before init', async () => {
  const worker = createWorker({ now: 1_000 })
  await init(worker)

  // The first load after a deploy fetches new assets before `init` arrives.
  worker.clock.now = 1_500
  await worker.fetchEvent(new Request(ASSET_A))
  await init(worker, { rev: 'r2', timeOrigin: 1_400 })

  worker.clock.now = 1_400 + 600_001
  await worker.message({ type: 'prune' })

  assert.deepEqual(assetKeys(worker), [ASSET_A])
})

test('never serves a cached full body to a range request', async () => {
  const worker = createWorker()
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const ranged = new Request(ASSET_A, { headers: { range: 'bytes=0-99' } })
  const result = await worker.fetchEvent(ranged)
  assert.equal(result.handled, true)
  assert.equal(worker.calls.length, 2)
  assert.equal(assetKeys(worker).length, 1)
})

test('does not store responses carrying Set-Cookie', async () => {
  const worker = createWorker({
    fetch: async () => new Response('cookie', { status: 200, headers: {
      'set-cookie': 'a=b',
      'x-dsh-upstream-cache-control': 'no-cache',
      etag: '"v1"',
    } }),
  })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(assetKeys(worker).length, 0)
})

test('does not store redirected responses', async () => {
  const worker = createWorker({
    fetch: async () => ({
      ok: true,
      status: 200,
      type: 'basic',
      redirected: true,
      url: ASSET_A,
      headers: new Headers({ 'x-dsh-upstream-cache-control': 'no-cache', etag: '"v1"' }),
    }),
  })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(assetKeys(worker).length, 0)
})

test('purges every owned cache on demand', async () => {
  const worker = createWorker()
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(worker.caches.has('dsh-static-v2'), true)
  await worker.message({ type: 'purge' })
  assert.equal(worker.caches.has('dsh-static-v2'), false)
})

test('purges when a navigation lands on the login page', async () => {
  const worker = createWorker({
    fetch: async () => ({
      redirected: true,
      url: 'https://dsh.test/_auth/login',
      status: 200,
      headers: new Headers(),
    }),
  })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const navigation = { url: 'https://dsh.test/', method: 'GET', mode: 'navigate', headers: new Headers() }
  const result = await worker.fetchEvent(navigation)
  assert.equal(result.handled, true)
  assert.equal(worker.caches.has('dsh-static-v2'), false)
})

test('purges when a navigation targets the login page directly', async () => {
  const worker = createWorker()
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const navigation = {
    url: 'https://dsh.test/_auth/login',
    method: 'GET',
    mode: 'navigate',
    headers: new Headers(),
  }
  const result = await worker.fetchEvent(navigation)
  assert.equal(result.handled, true)
  assert.equal(worker.caches.has('dsh-static-v2'), false)
})

test('primes only missing, allowed entries', async () => {
  const worker = createWorker()
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const reply = await worker.message({
    type: 'prime',
    urls: [ASSET_A, ASSET_B, 'https://dsh.test/api/session/list', 'https://dsh.test/plugins/events'],
  })
  assert.equal(reply.total, 4)
  assert.equal(reply.fetched, 1)
  assert.equal(reply.skipped, 3)
  assert.equal(worker.calls.length, 2)
})

test('evicts the oldest entry when the cache limit is reached', async () => {
  const worker = createWorker({
    fetch: async () => new Response('twenty-bytes-body!!!!', {
      status: 200,
      headers: { 'content-length': '20', 'x-dsh-upstream-cache-control': 'public, max-age=60' },
    }),
    config: workerConfig({ maxCacheBytes: 30, maxEntryBytes: 30 }),
  })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  await worker.fetchEvent(new Request(ASSET_B))
  assert.deepEqual(assetKeys(worker), [ASSET_B])
})

test('reports hits, misses, entries, and bytes', async () => {
  const worker = createWorker()
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  await worker.fetchEvent(new Request(ASSET_A))
  const stats = await worker.message({ type: 'stats' })
  assert.equal(stats.entries, 1)
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 1)
  assert.ok(stats.bytes > 0)
  assert.equal(stats.rev, 'r1')
})

test('does not store oversized responses', async () => {
  const worker = createWorker({
    fetch: async () => new Response('too-big', { status: 200, headers: {
      'content-length': '100',
      'x-dsh-upstream-cache-control': 'no-cache',
      etag: '"v1"',
    } }),
    config: workerConfig({ maxEntryBytes: 10, maxCacheBytes: 100 }),
  })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(assetKeys(worker).length, 0)
})

test('accounts for streamed responses that omit content-length', async () => {
  const worker = createWorker({ fetch: async () => new Response('streamed-body', { headers: { 'x-dsh-upstream-cache-control': 'public, max-age=60' } }) })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const stats = await worker.message({ type: 'stats' })
  assert.equal(stats.entries, 1)
  assert.ok(stats.bytes > 0)
})

test('floors fractional page time origins into the generation stamp', async () => {
  const worker = createWorker({ now: 1_000 })
  const stats = await worker.message({ type: 'init', rev: 'r1', timeOrigin: 1_000.75 })
  assert.equal(stats.generationStartedAt, 1_000)
})

test('removes metadata records whose bytes are gone', async () => {
  const worker = createWorker()
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const cache = await worker.caches.open('dsh-static-v2')
  await cache.delete(ASSET_A)
  const after = await worker.message({ type: 'prune' })
  assert.equal(after.entries, 0)
  assert.equal(after.bytes, 0)
})

test('drops bytes whose metadata record is gone', async () => {
  const first = createWorker()
  await init(first)
  await first.fetchEvent(new Request(ASSET_A))
  const cache = await first.caches.open('dsh-static-v2')
  const record = JSON.parse(await (await cache.match('https://dsh.test/__dsh-static-cache-meta__')).text())
  delete record.storedAt[ASSET_A]
  delete record.bytes[ASSET_A]
  await cache.put(
    'https://dsh.test/__dsh-static-cache-meta__',
    new Response(JSON.stringify(record), { headers: { 'content-type': 'application/json' } }),
  )

  const second = createWorker({ caches: first.caches })
  await init(second)
  await second.message({ type: 'prune' })
  assert.equal(assetKeys(second).length, 0)
})

test('does not overwrite good metadata when the record cannot be read', async () => {
  const first = createWorker()
  await init(first)
  await first.fetchEvent(new Request(ASSET_A))
  first.caches.failNextMatch('dsh-static-v2', 'https://dsh.test/__dsh-static-cache-meta__')

  // A restarted worker starts with no in-memory metadata and must read it.
  const second = createWorker({ caches: first.caches })
  const failed = await second.message({ type: 'init', rev: 'r2', timeOrigin: 2_000 })
  assert.ok(failed.lastError)
  assert.equal(assetKeys(second).length, 1)

  const cache = await second.caches.open('dsh-static-v2')
  const record = JSON.parse(await (await cache.match('https://dsh.test/__dsh-static-cache-meta__')).text())
  assert.ok(record.storedAt[ASSET_A] !== undefined)
})

test('re-stores an entry whose metadata record outlived its bytes', async () => {
  const worker = createWorker()
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const cache = await worker.caches.open('dsh-static-v2')
  await cache.delete(ASSET_A)
  await worker.fetchEvent(new Request(ASSET_A))
  const stats = await worker.message({ type: 'stats' })
  assert.equal(worker.calls.length, 2)
  assert.equal(stats.entries, 1)
  assert.equal(stats.bytes, ASSET_A.length)
})

test('drops a stale cache name on activate', async () => {
  const worker = createWorker()
  await worker.caches.open('dsh-static-v0')
  let activated
  worker.dispatch('activate', { waitUntil: promise => { activated = promise } })
  await activated
  assert.equal(worker.caches.has('dsh-static-v0'), false)
})


test('checks session before replay and purges after revocation', async () => {
  let active = true
  const worker = createWorker({ fetch: async request => {
    if (new URL(request.url).pathname === '/_auth/session') return new Response('{}', { status: active ? 200 : 401 })
    return new Response(active ? 'asset' : 'unauthorized', { status: active ? 200 : 401,
      headers: { 'x-dsh-upstream-cache-control': 'public, max-age=60' } })
  } })
  await worker.fetchEvent(new Request(ASSET_A))
  active = false
  const result = await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(result.response.status, 401)
  assert.equal(assetKeys(worker).length, 0)
})

test('purges after logout through fetch without page navigation', async () => {
  const worker = createWorker()
  await worker.fetchEvent(new Request(ASSET_A))
  await worker.fetchEvent(new Request('https://dsh.test/_auth/logout', { method: 'POST' }))
  assert.equal(assetKeys(worker).length, 0)
})


test('expires entries according to the upstream max-age', async () => {
  const worker = createWorker()
  await worker.fetchEvent(new Request(ASSET_A))
  worker.clock.now += 60_001
  await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(worker.calls.length, 2)
})

test('purges opaque manual-redirect logout responses', async () => {
  let logout = false
  const worker = createWorker({ fetch: async () => logout
    ? { ok: false, status: 0, type: 'opaqueredirect' }
    : new Response('asset', { headers: { 'x-dsh-upstream-cache-control': 'private, max-age=60' } }) })
  await worker.fetchEvent(new Request(ASSET_A))
  logout = true
  await worker.fetchEvent(new Request('https://dsh.test/_auth/logout', { method: 'POST', redirect: 'manual' }))
  assert.equal(assetKeys(worker).length, 0)
})


test('caches no-cache styles with a validator and revalidates them', async () => {
  const worker = createWorker({ fetch: async request => {
    if (new URL(request.url).pathname === '/_auth/session') return new Response('{}')
    const css = request.url.endsWith('.css')
    const etag = css ? '"css"' : null
    if (etag !== null && request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag, 'x-dsh-upstream-cache-control': 'no-cache' } })
    }
    return new Response('font resource', { headers: {
      'x-dsh-upstream-cache-control': css ? 'no-cache' : 'public, max-age=31536000, immutable',
      ...(etag === null ? {} : { etag }),
    } })
  } })
  const font = 'https://dsh.test/font-replacement/abcdef.woff2'
  const css = 'https://dsh.test/font-replacement/fonts.css'
  assert.equal((await worker.fetchEvent(new Request(font))).handled, true)
  await worker.fetchEvent(new Request(css))
  assert.deepEqual(assetKeys(worker).sort(), [css, font].sort())
  const replayed = await worker.fetchEvent(new Request(css))
  assert.equal(await replayed.response.text(), 'font resource')
  assert.equal(conditionalRequests(worker).length, 1)
})

test('stores a no-cache response that carries a validator', async () => {
  const worker = createWorker({ fetch: etagFetch() })
  await init(worker)
  const first = await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(await first.response.text(), 'asset-v1')
  assert.deepEqual(assetKeys(worker), [ASSET_A])
  const stats = await worker.message({ type: 'stats' })
  assert.equal(stats.entries, 1)
})

test('rejects a no-cache response without a validator', async () => {
  const worker = createWorker({ fetch: async () => new Response('asset', { headers: {
    'x-dsh-upstream-cache-control': 'no-cache',
  } }) })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(assetKeys(worker).length, 0)
})

test('revalidates with If-Modified-Since when only Last-Modified is present', async () => {
  const lastModified = 'Thu, 26 Nov 2026 13:42:27 GMT'
  let revalidated = 0
  const worker = createWorker({ fetch: async request => {
    if (new URL(request.url).pathname === '/_auth/session') return new Response('{}')
    if (request.headers.get('if-modified-since') === lastModified) {
      revalidated += 1
      return new Response(null, { status: 304, headers: {
        'x-dsh-upstream-cache-control': 'no-cache',
        'last-modified': lastModified,
      } })
    }
    return new Response('asset-v1', { headers: {
      'x-dsh-upstream-cache-control': 'no-cache',
      'last-modified': lastModified,
      'content-length': '8',
    } })
  } })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(revalidated, 1)
  assert.deepEqual(assetKeys(worker), [ASSET_A])
})

test('revalidates with If-None-Match and serves stored bytes on 304', async () => {
  const worker = createWorker({ fetch: etagFetch() })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const second = await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(await second.response.text(), 'asset-v1')
  assert.deepEqual(conditionalRequests(worker).map(request => request.headers.get('if-none-match')), ['"v1"'])
  const stats = await worker.message({ type: 'stats' })
  assert.equal(stats.entries, 1)
  assert.equal(stats.hits, 1)
  assert.equal(stats.misses, 1)
  assert.equal(stats.revalidated, 1)
})

test('replaces an entry when revalidation returns changed bytes', async () => {
  let version = 1
  const worker = createWorker({ fetch: async request => {
    if (new URL(request.url).pathname === '/_auth/session') return new Response('{}')
    const etag = `"v${version}"`
    if (request.headers.get('if-none-match') === etag) {
      return new Response(null, { status: 304, headers: { etag, 'x-dsh-upstream-cache-control': 'no-cache' } })
    }
    const body = `asset-v${version}`
    return new Response(body, { headers: {
      etag,
      'x-dsh-upstream-cache-control': 'no-cache',
      'content-length': String(body.length),
    } })
  } })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  version = 2
  const second = await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(await second.response.text(), 'asset-v2')
  const third = await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(await third.response.text(), 'asset-v2')
  const stats = await worker.message({ type: 'stats' })
  assert.equal(stats.entries, 1)
  assert.equal(stats.revalidated, 1)
})

test('drops an entry when revalidation returns a non-admissible response', async () => {
  let changed = false
  const worker = createWorker({ fetch: async request => {
    if (new URL(request.url).pathname === '/_auth/session') return new Response('{}')
    if (changed) return new Response('changed', { headers: { 'cache-control': 'no-store' } })
    return new Response('asset-v1', { headers: {
      etag: '"v1"',
      'x-dsh-upstream-cache-control': 'no-cache',
      'content-length': '8',
    } })
  } })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  changed = true
  const second = await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(await second.response.text(), 'changed')
  assert.equal(assetKeys(worker).length, 0)
  const stats = await worker.message({ type: 'stats' })
  assert.equal(stats.dropped, 1)
})

test('refreshes storedAt when revalidation returns 304', async () => {
  const worker = createWorker({ fetch: etagFetch() })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const cache = await worker.caches.open('dsh-static-v2')
  const metaUrl = 'https://dsh.test/__dsh-static-cache-meta__'
  const before = JSON.parse(await (await cache.match(metaUrl)).text())
  worker.clock.now += 10_000
  await worker.fetchEvent(new Request(ASSET_A))
  const after = JSON.parse(await (await cache.match(metaUrl)).text())
  assert.ok(after.storedAt[ASSET_A] > before.storedAt[ASSET_A])
  assert.equal(after.bytes[ASSET_A], before.bytes[ASSET_A])
})

test('purges and does not serve cached bytes when the session is revoked during revalidation', async () => {
  let active = true
  const worker = createWorker({ fetch: async request => {
    if (new URL(request.url).pathname === '/_auth/session') {
      return new Response('{}', { status: active ? 200 : 401 })
    }
    if (request.headers.get('if-none-match') === '"v1"') {
      return new Response(null, { status: 304, headers: { etag: '"v1"', 'x-dsh-upstream-cache-control': 'no-cache' } })
    }
    if (!active) return new Response('unauthorized', { status: 401 })
    return new Response('asset-v1', { headers: {
      etag: '"v1"',
      'x-dsh-upstream-cache-control': 'no-cache',
      'content-length': '8',
    } })
  } })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  active = false
  const second = await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(second.response.status, 401)
  assert.equal(assetKeys(worker).length, 0)
})

test('serves fresh immutable entries without a conditional request on reload', async () => {
  const worker = createWorker({ fetch: etagFetch({ policy: 'public, max-age=60, immutable' }) })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const before = worker.requests.length
  const reloaded = await worker.fetchEvent(new Request(ASSET_A, { cache: 'reload' }))
  assert.equal(await reloaded.response.text(), 'asset-v1')
  assert.equal(worker.requests.slice(before).filter(request => request.headers.has('if-none-match')).length, 0)
})

test('revalidates a fresh non-immutable entry when the request asks for reload', async () => {
  const worker = createWorker({ fetch: etagFetch({ policy: 'public, max-age=60' }) })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const before = worker.requests.length
  await worker.fetchEvent(new Request(ASSET_A, { cache: 'reload' }))
  assert.equal(worker.requests.slice(before).filter(request => request.headers.get('if-none-match') === '"v1"').length, 1)
})

test('revalidates a fresh non-immutable entry when the request sends max-age=0', async () => {
  const worker = createWorker({ fetch: etagFetch({ policy: 'public, max-age=60' }) })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const before = worker.requests.length
  await worker.fetchEvent(new Request(ASSET_A, { headers: { 'cache-control': 'max-age=0' } }))
  assert.equal(worker.requests.slice(before).filter(request => request.headers.get('if-none-match') === '"v1"').length, 1)
})

test('does not let immutable suppress the no-cache requirement', async () => {
  const worker = createWorker({ fetch: etagFetch({ policy: 'no-cache, immutable' }) })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  const before = worker.requests.length
  await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(worker.requests.slice(before).filter(request => request.headers.get('if-none-match') === '"v1"').length, 1)
})

test('does not let immutable override no-store', async () => {
  const worker = createWorker({ fetch: async () => new Response('asset', { headers: {
    'x-dsh-upstream-cache-control': 'no-store, immutable',
    etag: '"v1"',
  } }) })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(assetKeys(worker).length, 0)
})

test('keeps no-cache responses on the network when revalidation is disabled', async () => {
  const worker = createWorker({ fetch: etagFetch(), config: workerConfig({ revalidate: false }) })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(assetKeys(worker).length, 0)
  const second = await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(await second.response.text(), 'asset-v1')
  assert.equal(conditionalRequests(worker).length, 0)
})

test('revalidates an expired max-age entry that carries a validator', async () => {
  const worker = createWorker({ fetch: etagFetch({ policy: 'public, max-age=1' }) })
  await init(worker)
  await worker.fetchEvent(new Request(ASSET_A))
  worker.clock.now += 1_001
  const before = worker.requests.length
  await worker.fetchEvent(new Request(ASSET_A))
  assert.equal(worker.requests.slice(before).filter(request => request.headers.get('if-none-match') === '"v1"').length, 1)
  const stats = await worker.message({ type: 'stats' })
  assert.equal(stats.revalidated, 1)
})

test('primes a no-cache entry that carries a validator', async () => {
  const worker = createWorker({ fetch: etagFetch() })
  await init(worker)
  const reply = await worker.message({ type: 'prime', urls: [ASSET_A] })
  assert.equal(reply.fetched, 1)
  assert.deepEqual(assetKeys(worker), [ASSET_A])
})
