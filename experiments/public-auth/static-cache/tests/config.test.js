import test from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULTS, resolveConfig } from '../dist/config.js'

test('applies documented defaults', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.route, DEFAULTS.route)
  assert.equal(config.scope, '/')
  assert.deepEqual(config.prefixes, ['/assets/', '/plugins/', '/font-replacement/'])
  assert.deepEqual(config.exclude, ['/plugins/events'])
  assert.equal(config.prime, true)
  assert.equal(config.concurrency, 4)
  assert.equal(config.revalidate, true)
  assert.ok(Object.isFrozen(config))
})

test('accepts a full override', () => {
  const config = resolveConfig({
    route: '/x/sw.js',
    scope: '/',
    prefixes: ['/assets/'],
    exclude: ['/assets/skip.js'],
    prime: false,
    concurrency: 2,
    maxCacheBytes: 1024,
    maxEntryBytes: 512,
    graceMinutes: 1,
    maxAgeDays: 2,
    revalidate: false,
  })
  assert.equal(config.route, '/x/sw.js')
  assert.deepEqual(config.prefixes, ['/assets/'])
  assert.equal(config.prime, false)
  assert.equal(config.maxCacheBytes, 1024)
  assert.equal(config.revalidate, false)
})

test('rejects a prefix outside the scope on a segment boundary', () => {
  assert.throws(() => resolveConfig({ scope: '/app/', prefixes: ['/assets/'] }), /outside scope/)
  assert.throws(() => resolveConfig({ scope: '/app', prefixes: ['/appx/'] }), /outside scope/)
  assert.doesNotThrow(() => resolveConfig({ scope: '/app', route: '/app/sw.js', prefixes: ['/app/assets/'], exclude: ['/app/assets/skip.js'] }))
})

test('keeps the worker route inside the scope and outside cache prefixes', () => {
  assert.throws(() => resolveConfig({ scope: '/app' }), /outside scope/)
  assert.throws(() => resolveConfig({ route: '/assets/sw.js' }), /must not live under cache prefix/)
  assert.doesNotThrow(() => resolveConfig({ route: '/__dsh/sw.js' }))
})

test('rejects cache prefixes that overlap reserved paths or cover everything', () => {
  assert.throws(() => resolveConfig({ prefixes: ['/'], exclude: [] }), /top-level path/)
  assert.throws(() => resolveConfig({ prefixes: ['/api/'] }), /reserved path/)
  assert.throws(() => resolveConfig({ route: '/api/sw.js' }), /must not live under "\/api"/)
})

test('rejects excludes outside every cache prefix', () => {
  assert.throws(() => resolveConfig({ prefixes: ['/assets/'] }), /not under any cache prefix/)
  assert.doesNotThrow(() => resolveConfig({ prefixes: ['/assets/'], exclude: ['/assets/skip.js'] }))
})

test('rejects a malformed route', () => {
  assert.throws(() => resolveConfig({ route: 'sw.js' }), /absolute path/)
  assert.throws(() => resolveConfig({ route: '/sw.js?v=1' }), /absolute path/)
})

test('rejects empty path lists', () => {
  assert.throws(() => resolveConfig({ prefixes: [] }), /non-empty array/)
  assert.throws(() => resolveConfig({ exclude: ['x'] }), /absolute paths/)
})

test('rejects non-positive integers', () => {
  assert.throws(() => resolveConfig({ concurrency: 0 }), /positive integer/)
  assert.throws(() => resolveConfig({ concurrency: 1.5 }), /positive integer/)
})

test('rejects an entry limit above the cache limit', () => {
  assert.throws(() => resolveConfig({ maxCacheBytes: 100, maxEntryBytes: 200 }), /must not exceed/)
})

test('rejects non-object config', () => {
  assert.throws(() => resolveConfig([]), /config must be an object/)
  assert.throws(() => resolveConfig('x'), /config must be an object/)
})
