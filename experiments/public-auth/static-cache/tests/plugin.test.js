import test from 'node:test'
import assert from 'node:assert/strict'
import { apply, workerSource } from '../src/index.js'
import { resolveConfig } from '../src/config.js'

function createHost() {
  const routes = []
  const listeners = new Map()
  const ctx = {
    effect(fn) {
      const dispose = fn()
      return dispose
    },
    on(event, listener) {
      const group = listeners.get(event) ?? []
      group.push(listener)
      listeners.set(event, group)
      return () => {}
    },
    webServer: {
      register(route) {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    },
  }
  return { ctx, routes, listeners }
}

/** @param {(typeof import('../src/index.js'))['apply']} _apply */
function invoke(route, method = 'GET') {
  const captured = { status: 0, headers: {}, body: undefined }
  route.handler({ method, url: route.path }, {
    writeHead(status, headers) {
      captured.status = status
      captured.headers = headers
    },
    end(body) {
      captured.body = body
    },
  })
  return captured
}

test('registers the worker route with service-worker headers', () => {
  const host = createHost()
  apply(host.ctx, {})
  assert.equal(host.routes.length, 1)
  const route = host.routes[0]
  assert.equal(route.kind, 'exact')
  assert.equal(route.path, '/__dsh-static-cache/sw.js')
  const response = invoke(route)
  assert.equal(response.status, 200)
  assert.equal(response.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(response.headers['service-worker-allowed'], '/')
  assert.equal(response.headers['cache-control'], 'no-cache')
  assert.match(response.body, /dsh-static-v1/)
  assert.ok(response.body.includes('"prefixes":["/assets/","/plugins/"]'))
  assert.ok(!response.body.includes('dsh-static-cache:config'))
})

test('bakes the resolved policy into the served worker', () => {
  const source = workerSource(resolveConfig({ concurrency: 2, graceMinutes: 1, maxAgeDays: 2 }))
  assert.ok(source.includes('"concurrency":2'))
  assert.ok(source.includes('"graceMs":60000'))
  assert.ok(source.includes('"maxAgeMs":172800000'))
  assert.ok(!source.includes('dsh-static-cache:config'))
})

test('answers HEAD without a body and other methods with 405', () => {
  const host = createHost()
  apply(host.ctx, {})
  const route = host.routes[0]
  assert.equal(invoke(route, 'HEAD').body, undefined)
  const rejected = invoke(route, 'POST')
  assert.equal(rejected.status, 405)
  assert.equal(rejected.headers.allow, 'GET, HEAD')
})

test('injects one head registration row', () => {
  const host = createHost()
  apply(host.ctx, { route: '/custom/sw.js' })
  const rows = []
  for (const listener of host.listeners.get('webserver/index-inject') ?? []) listener(rows)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].kind, 'script')
  assert.equal(rows[0].placement, 'head')
  assert.ok(rows[0].text.includes('/custom/sw.js'))
  assert.doesNotThrow(() => new Function(rows[0].text))
})

test('rejects malformed config at load', () => {
  const host = createHost()
  assert.throws(() => apply(host.ctx, { prefixes: [] }), /non-empty array/)
  assert.equal(host.routes.length, 0)
})
