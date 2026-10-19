import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { request } from '../src/http-request.mjs'

test('local probes preserve the configured Host and return separate cookies without following redirects', async () => {
  const server = createServer((incoming, response) => {
    if (incoming.headers.host !== 'harness.example.com') { response.writeHead(403).end(); return }
    response.writeHead(303, { location: '/must-not-follow', 'set-cookie': ['one=first; Path=/', 'two=second; Path=/'] })
    response.end('ready')
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const response = await request(`http://127.0.0.1:${address.port}`, { headers: { host: 'harness.example.com' } })
    assert.equal(response.status, 303)
    assert.deepEqual(response.headers.getSetCookie(), ['one=first; Path=/', 'two=second; Path=/'])
    assert.equal(await response.text(), 'ready')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
