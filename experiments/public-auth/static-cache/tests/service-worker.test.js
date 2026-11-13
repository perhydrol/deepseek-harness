import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorker, workerConfig } from './harness.js'

const ASSET_A = 'https://dsh.test/assets/index-abcdef12.js'
const ASSET_B = 'https://dsh.test/assets/vendor-12345678.js'
const META = '/__dsh-static-cache-meta__'

test('rejects missing and forbidden upstream cache policies', async () => {
  for (const policy of [null, 'no-store', 'no-cache', 'public, max-age=0']) {
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
    fetch: async () => new Response('cookie', { status: 200, headers: { 'set-cookie': 'a=b' } }),
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
      headers: new Headers(),
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
    fetch: async () => new Response('too-big', { status: 200, headers: { 'content-length': '100' } }),
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


test('caches font fragments but keeps the revalidated stylesheet on the network', async () => {
  const worker = createWorker({ fetch: async request => new Response('font resource', { headers: {
    'x-dsh-upstream-cache-control': request.url.endsWith('.woff2') ? 'public, max-age=31536000, immutable' : 'no-cache',
  } }) })
  const font = 'https://dsh.test/font-replacement/abcdef.woff2'
  const css = 'https://dsh.test/font-replacement/fonts.css'
  assert.equal((await worker.fetchEvent(new Request(font))).handled, true)
  await worker.fetchEvent(new Request(css))
  assert.deepEqual(assetKeys(worker), [font])
})
