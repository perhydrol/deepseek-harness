/** Black-box proxy checks using an owned HTTP/WebSocket upstream fixture. */
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingHttpHeaders } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { WebSocket, WebSocketServer } from 'ws'
import { createProxy } from '../src/proxy.ts'
import { initialize } from '../src/auth.ts'

const PASSWORD = 'a-test-password-only'
const PUBLIC = 'https://dsh.example.test'

test('private upstream exchange, session persistence, HTTP, WS, and revocation', { timeout: 30_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-auth-'))
  await initialize(directory, PASSWORD)
  let requests = 0
  let exchanges = 0
  let refuseCredential = true
  let exchangeGate: Promise<void> | undefined
  let exchangeStarted: (() => void) | undefined
  let releaseExchange: (() => void) | undefined
  let captured: IncomingHttpHeaders = {}
  const immutable = 'public, max-age=31536000, immutable'
  const resources = [
    { path: '/assets/index-CN7NIWNw.js', type: 'application/javascript', cacheable: true },
    { path: '/assets/index-BxpfOGf3.css', type: 'text/css; charset=utf-8', cacheable: true },
    { path: '/plugins/??@example/plugin/client.js&rev=ec4b9a3a01eb', type: 'text/javascript', cache: immutable, cacheable: true },
    { path: '/plugins/@example/plugin/client.chunk.js?rev=ec4b9a3a01eb', type: 'text/javascript', cache: immutable, cacheable: true },
    { path: '/assets/plain.js', type: 'text/javascript', cacheable: false },
    { path: '/assets/index-CN7NIWNw.js?preview=1', type: 'text/javascript', cacheable: false },
    { path: '/assets/document-CN7NIWNw.js', type: 'text/html', cacheable: false },
    { path: '/assets/missing-CN7NIWNw.js', type: 'text/javascript', status: 404, cacheable: false },
    { path: '/assets/refused-CN7NIWNw.js', type: 'text/javascript', status: 401, cacheable: false },
    { path: '/assets/unavailable-CN7NIWNw.js', type: 'text/javascript', status: 503, cacheable: false },
    { path: '/plugins/??@example/plugin/client.js', type: 'text/javascript', cache: immutable, cacheable: false },
    { path: '/plugins/??@example/plugin/client.js&rev=ec4b9a3a01ec', type: 'text/javascript', cacheable: false },
    { path: '/plugins/??@example/plugin/client.js&rev=ec4b9a3a01ed', type: 'text/javascript', cache: 'no-store, immutable', cacheable: false },
    { path: '/api/file?path=/assets/index-CN7NIWNw.js', type: 'text/javascript', cache: immutable, cacheable: false },
  ]
  const upstream = createServer((request, response) => {
    if (request.url === '/?token=private-token') {
      exchanges++
      const send = () => { response.writeHead(303, { location: './', 'set-cookie': 'dsh-auth-fixture=private-cookie; HttpOnly' }).end() }
      if (exchangeGate) {
        exchangeStarted?.()
        void exchangeGate.then(send)
      } else send()
      return
    }
    requests++
    captured = request.headers
    if (request.headers.cookie !== 'dsh-auth-fixture=private-cookie') {
      response.writeHead(401).end()
      return
    }
    const resource = resources.find(value => value.path === request.url)
    if (resource) {
      response.writeHead(resource.status ?? 200, {
        'content-type': resource.type,
        ...(resource.cache === undefined ? {} : { 'cache-control': resource.cache }),
      }).end('fixture resource')
      return
    }
    if (request.url === '/fail-write') {
      response.writeHead(503).end('not committed')
      return
    }
    if (request.url === '/renew' && refuseCredential) {
      refuseCredential = false
      response.writeHead(401).end('credential expired')
      return
    }
    if (request.url === '/stream') {
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write('data: first\n\n')
      response.end('data: second\n\n')
      return
    }
    response.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': 'dsh-auth-fixture=must-not-leak' })
    request.pipe(response)
  })
  const wss = new WebSocketServer({ server: upstream })
  wss.on('connection', (socket, request) => {
    captured = request.headers
    socket.on('message', (data, binary) => socket.send(data, { binary }))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const address = upstream.address()
  assert.ok(address && typeof address === 'object')
  const file = join(directory, 'launch-url.txt')
  await writeFile(file, `http://127.0.0.1:${address.port}/?token=private-token`)
  const config = {
    publicOrigin: PUBLIC, stateDirectory: directory, launchUrlFile: file,
    sessionSeconds: 86400, loginAttempts: 4, loginWindowSeconds: 60,
  }
  let app = await createProxy(config)
  t.after(async () => {
    releaseExchange?.()
    await app.close()
    for (const client of wss.clients) client.terminate()
    await new Promise<void>(resolve => wss.close(() => resolve()))
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const common = { host: 'dsh.example.test', origin: PUBLIC }
  assert.equal((await app.inject({ url: '/_auth/login', headers: common })).headers['referrer-policy'], 'same-origin')
  assert.equal((await app.inject({ method: 'POST', url: '/_auth/login', headers: { ...common, origin: 'null' } })).statusCode, 403)
  const login = await app.inject({
    method: 'POST', url: '/_auth/login', headers: { ...common, 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ password: PASSWORD }).toString(),
  })
  assert.equal(login.statusCode, 303)
  const cookieHeaders = login.headers['set-cookie']
  const setCookie = Array.isArray(cookieHeaders) ? cookieHeaders.find(value => value.includes('dsh-proxy=')) : cookieHeaders
  assert.equal(typeof setCookie, 'string')
  assert.match(String(setCookie), /HttpOnly/)
  assert.match(String(setCookie), /Secure/)
  assert.match(String(setCookie), /SameSite=Strict/)
  const credential = String(setCookie).split(';')[0]!
  assert.match(credential, /^__Secure-dsh-proxy=/)
  assert.ok(!credential.includes('private-token') && !credential.includes('private-cookie'))
  const headers = { ...common, cookie: credential }
  for (const path of ['/', '/api/settings/mutate', '/stream']) {
    assert.equal((await app.inject({ url: path, headers: common })).statusCode, 401)
  }
  assert.equal(requests, 0)
  assert.equal((await app.inject({ url: '/', headers: { ...headers, host: 'evil.test' } })).statusCode, 403)
  assert.equal((await app.inject({ url: '/', headers: { ...headers, origin: 'https://evil.test' } })).statusCode, 403)
  assert.equal((await app.inject({ url: '/', headers: { ...headers, 'sec-fetch-site': 'cross-site' } })).statusCode, 403)
  assert.equal((await app.inject({ url: '/connect', headers })).statusCode, 403)
  assert.equal((await app.inject({ url: '/?token=stolen', headers })).statusCode, 403)
  const result = await app.inject({
    method: 'POST', url: '/api/settings/mutate',
    headers: { ...headers, 'content-type': 'application/json', authorization: 'Bearer evil', 'x-forwarded-host': 'evil.test' },
    payload: { change: true },
  })
  assert.equal(result.statusCode, 200)
  assert.deepEqual(JSON.parse(result.body), { change: true })
  assert.equal(captured.cookie, 'dsh-auth-fixture=private-cookie')
  assert.equal(captured.origin, `http://127.0.0.1:${address.port}`)
  assert.equal(captured.authorization, undefined)
  assert.equal(captured['x-forwarded-host'], undefined)
  assert.equal(result.headers['set-cookie'], undefined)
  await t.test('only successful versioned scripts and styles receive private browser caching', async () => {
    for (const resource of resources) {
      for (const method of ['GET', 'HEAD'] as const) {
        const response = await app.inject({ method, url: resource.path, headers })
        assert.equal(response.statusCode, resource.status ?? 200)
        assert.equal(response.headers['cache-control'], resource.cacheable
          ? 'private, max-age=31536000, immutable' : 'no-store', `${method} ${resource.path}`)
      }
    }
    const anonymous = await app.inject({ url: resources[0]!.path, headers: common })
    assert.equal(anonymous.statusCode, 401)
    assert.equal(anonymous.headers['cache-control'], 'no-store')
    assert.equal((await app.inject({ method: 'POST', url: resources[0]!.path, headers })).headers['cache-control'], 'no-store')
    for (const path of ['/', '/_auth/login', '/_auth/session', '/api/settings/mutate', '/stream']) {
      assert.equal((await app.inject({ url: path, headers })).headers['cache-control'], 'no-store', path)
    }
  })
  assert.equal((await app.inject({ url: '/stream', headers })).body, 'data: first\n\ndata: second\n\n')
  const before = requests
  assert.equal((await app.inject({ method: 'POST', url: '/fail-write', headers })).statusCode, 503)
  assert.equal(requests, before + 1)
  const beforeRenew = requests
  const beforeExchange = exchanges
  assert.equal((await app.inject({ method: 'POST', url: '/renew', headers })).statusCode, 401)
  assert.equal(requests, beforeRenew + 1)
  assert.equal((await app.inject({ url: '/renew', headers })).statusCode, 200)
  assert.equal(exchanges, beforeExchange + 1)

  const listen = await app.listen({ host: '127.0.0.1', port: 0 })
  const socket = new WebSocket(listen.replace('http:', 'ws:') + '/api/remote.mux', { headers })
  await once(socket, 'open')
  const echoed = once(socket, 'message')
  socket.send('hello through authenticated proxy')
  const [message] = await echoed
  assert.equal(String(message), 'hello through authenticated proxy')
  assert.equal(captured.cookie, 'dsh-auth-fixture=private-cookie')
  socket.close()
  await once(socket, 'close')
  const revokedSocket = new WebSocket(listen.replace('http:', 'ws:') + '/api/remote.mux', { headers })
  await once(revokedSocket, 'open')
  const revoked = once(revokedSocket, 'close')
  refuseCredential = true
  assert.equal((await app.inject({ url: '/renew', headers })).statusCode, 401)
  exchangeGate = new Promise<void>(resolve => { releaseExchange = resolve })
  const renewing = new Promise<void>(resolve => { exchangeStarted = resolve })
  const pendingSocket = new WebSocket(listen.replace('http:', 'ws:') + '/api/remote.mux', { headers })
  let pendingOpened = false
  pendingSocket.on('open', () => { pendingOpened = true })
  pendingSocket.on('error', () => { /* Logout closes a handshake whose upstream exchange is pending. */ })
  const pendingClosed = new Promise<void>(resolve => pendingSocket.once('close', () => resolve()))
  await renewing
  assert.equal((await app.inject({ method: 'POST', url: '/_auth/logout', headers })).statusCode, 303)
  releaseExchange?.()
  exchangeGate = undefined
  await revoked
  await pendingClosed
  assert.equal(pendingOpened, false)
  assert.equal((await app.inject({ url: '/_auth/session', headers })).statusCode, 401)
  // A fresh login provides the credential used for the restart check below.
  const freshLogin = await app.inject({ method: 'POST', url: '/_auth/login', headers: { ...common, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ password: PASSWORD }).toString() })
  const freshCookies = freshLogin.headers['set-cookie']
  headers.cookie = String(Array.isArray(freshCookies) ? freshCookies.find(value => value.includes('dsh-proxy=')) : freshCookies).split(';')[0]!
  const refused = new WebSocket(listen.replace('http:', 'ws:') + '/api/remote.mux', { headers: common })
  const rejected = new Promise<number>((resolve, reject) => {
    refused.on('unexpected-response', (_request, response) => { response.resume(); refused.terminate(); resolve(response.statusCode ?? 0) })
    refused.on('open', () => reject(new Error('Anonymous websocket admitted')))
    refused.on('error', () => { /* Termination after the refused handshake has no connected socket. */ })
  })
  assert.equal(await rejected, 401)
  await app.close()
  app = await createProxy(config)
  assert.equal((await app.inject({ url: '/_auth/session', headers })).statusCode, 200)
  assert.equal((await app.inject({ method: 'POST', url: '/_auth/logout', headers: { host: common.host, cookie: headers.cookie } })).statusCode, 403)
  assert.equal((await app.inject({ method: 'POST', url: '/_auth/logout', headers })).statusCode, 303)
  assert.equal((await app.inject({ url: '/_auth/session', headers })).statusCode, 401)
  const badLogin = { method: 'POST' as const, url: '/_auth/login', headers: { ...common, 'content-type': 'application/x-www-form-urlencoded' }, payload: 'password=wrong' }
  for (let attempt = 0; attempt < 2; attempt++) assert.equal((await app.inject(badLogin)).statusCode, 401)
  assert.equal((await app.inject(badLogin)).statusCode, 429)
  const db = await readFile(join(directory, 'auth.sqlite'))
  assert.ok(!db.includes(Buffer.from(PASSWORD)))
})

test('initialization refuses to replace an existing owner', { timeout: 10_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-auth-sessions-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await initialize(directory, PASSWORD)
  await assert.rejects(initialize(directory, 'a-different-password'))
})
