/** Owned HTTP/WebSocket upstream fixture for public-auth load measurements. */
import { createServer } from 'node:http'
import process from 'node:process'
import { URL } from 'node:url'
import { WebSocketServer } from 'ws'

const upstreamCookie = 'dsh-auth-fixture=private-cookie'
const html = `<!doctype html><html><body>${'d'.repeat(8 * 1024)}</body></html>`
const json = JSON.stringify({ sessions: 's'.repeat(2 * 1024) })
const asset = `/*! fixture */\n${'a'.repeat(300 * 1024)}`
const style = `/* fixture */\n${'c'.repeat(32 * 1024)}\n`
const plugin = `/* plugin fixture */\n${'p'.repeat(64 * 1024)}\n`
const immutable = 'public, max-age=31536000, immutable'

const server = createServer((request, response) => {
  if (request.url === '/?token=private-token') {
    response.writeHead(303, {
      location: './',
      'set-cookie': `${upstreamCookie}; HttpOnly; Max-Age=86400`,
    }).end()
    return
  }
  if (request.headers.cookie !== upstreamCookie) {
    response.writeHead(401).end('upstream credential missing')
    return
  }
  const path = new URL(request.url ?? '/', 'http://fixture').pathname
  if (request.method === 'POST') {
    // DSH mutations read the request body; consume it before responding.
    request.resume()
    request.once('end', () => response.writeHead(200, { 'content-type': 'application/json' }).end(json))
    return
  }
  if (path === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html)
  } else if (path === '/api/session') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(json)
  } else if (path === '/assets/index-CN7NIWNw.js') {
    response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': immutable }).end(asset)
  } else if (path === '/assets/index-BxpfOGf3.css') {
    response.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': immutable }).end(style)
  } else if (path === '/plugins/@example/plugin/client.js') {
    response.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': immutable }).end(plugin)
  } else {
    response.writeHead(404).end()
  }
})

const sockets = new WebSocketServer({ noServer: true })
sockets.on('connection', socket => {
  socket.on('message', (data, binary) => socket.send(data, { binary }))
})
server.on('upgrade', (request, socket, head) => {
  if (request.headers.cookie !== upstreamCookie) {
    socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n')
    return
  }
  sockets.handleUpgrade(request, socket, head, client => sockets.emit('connection', client, request))
})

server.listen(0, '127.0.0.1', () => {
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Fixture did not bind a TCP port')
  process.send?.({ type: 'ready', port: address.port })
})

let closing = false
const close = () => {
  if (closing) return
  closing = true
  for (const socket of sockets.clients) socket.terminate()
  sockets.close()
  server.closeAllConnections()
  server.close(() => process.exit(0))
}
process.on('message', message => {
  if (message === 'close') close()
})
process.on('disconnect', close)
