/** Independent single-owner proxy; upstream authentication stays server-side. */
import { readFile } from 'node:fs/promises'
import type { IncomingHttpHeaders } from 'node:http'
import type { Socket } from 'node:net'
import Fastify from 'fastify'
import type { FastifyRequest } from 'fastify'
import formbody from '@fastify/formbody'
import proxy from '@fastify/http-proxy'
import { fromNodeHeaders } from 'better-auth/node'
import { openAuth, OWNER_EMAIL } from './auth.ts'

/** Explicit deployment configuration; HTTP is permitted only on loopback origins. */
export interface ProxyConfig {
  publicOrigin: string
  launchUrlFile: string
  stateDirectory: string
  sessionSeconds: number
  loginAttempts: number
  loginWindowSeconds: number
}

const LOGIN = `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DSH 登录</title><style>
body{font:17px system-ui;background:#f5f5f4;color:#202020;margin:15vh auto;padding:24px;max-width:380px}
form{display:grid;gap:18px}input,button{font:inherit;padding:12px;border:1px solid #aaa;border-radius:8px}
button{background:#202020;color:white;cursor:pointer}small{color:#555}
</style><h1>登录 DSH</h1><form action="/_auth/login" method="post">
<label for="password">管理员密码</label><input id="password" type="password" name="password"
required maxlength="1024" autocomplete="current-password" autofocus>
<button>登录</button><small>此浏览器将记住登录状态。请仅在自己的设备上登录。</small></form></html>`

/** Status-bearing errors contain only public diagnostics. */
function reject(statusCode: number, message: string): never {
  throw Object.assign(new Error(message), { statusCode })
}

/** Exchange the private launch token; errors never expose credential-bearing URLs. */
async function exchange(file: string): Promise<{ origin: string; cookie: string; expires: number }> {
  try {
    const url = new URL((await readFile(file, 'utf8')).trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.hash || url.searchParams.size !== 1 || !url.searchParams.get('token')) {
      throw new Error('Invalid private launch URL')
    }
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })
    await response.body?.cancel()
    const values = response.headers.getSetCookie().filter(value => value.startsWith('dsh-auth-'))
    const value = values[0]?.split(';')[0]
    if (response.status !== 303 || values.length !== 1 || !value) throw new Error('DSH refused token')
    const maxAge = /(?:^|;)\s*Max-Age=(\d+)/i.exec(values[0] ?? '')?.[1]
    return { origin: url.origin, cookie: value, expires: Date.now() + Number(maxAge ?? 86400) * 1000 }
  } catch {
    // Credential-bearing transport errors must not reach logs or HTTP responses.
    throw new Error('DSH token exchange failed; check the private launch URL file and DSH listener')
  }
}

/** Build an independently installable proxy using DSH's existing token exchange. */
export async function createProxy(config: ProxyConfig) {
  const origin = new URL(config.publicOrigin)
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Public origin must have no path or credentials')
  if (origin.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) {
    throw new Error('Public origin requires HTTPS; only loopback HTTP is permitted')
  }
  for (const value of [config.sessionSeconds, config.loginAttempts, config.loginWindowSeconds]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Session and login limits must be positive integers')
  }
  let upstream = await exchange(config.launchUrlFile)
  let renewal: Promise<void> | undefined
  const renew = (): Promise<void> => {
    renewal ??= exchange(config.launchUrlFile).then(next => {
      if (next.origin !== upstream.origin) throw new Error('Upstream origin changed; restart the proxy')
      upstream = next
    }).finally(() => { renewal = undefined })
    return renewal
  }
  const { auth, database } = openAuth(config)
  const app = Fastify({ logger: false, trustProxy: false, bodyLimit: 4096 })
  const sockets = new Map<string, Set<Socket>>()
  await app.register(formbody)
  app.addHook('preClose', async () => {
    for (const group of sockets.values()) for (const socket of group) socket.destroy()
  })
  app.addHook('onClose', async () => { database.close() })
  const getSession = (request: FastifyRequest) => auth.api.getSession({ headers: fromNodeHeaders(request.headers) })
  const authRequest = async (request: FastifyRequest, endpoint: string, body: object) => {
    const headers = fromNodeHeaders(request.headers)
    headers.set('content-type', 'application/json')
    headers.set('x-proxy-client-ip', request.ip)
    headers.delete('content-length')
    return auth.handler(new Request(`${origin.origin}/_auth/api/${endpoint}`, {
      method: 'POST', headers, body: JSON.stringify(body),
    }))
  }
  app.addHook('onRequest', async (request, reply) => {
    reply.headers({ 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-content-type-options': 'nosniff' })
    if (request.headers.host !== origin.host) reject(403, 'Unexpected host')
    const source = request.headers.origin
    if ((source !== undefined && source !== origin.origin) || request.headers['sec-fetch-site'] === 'cross-site') {
      reject(403, 'Cross-origin access refused')
    }
    const url = new URL(request.url, origin)
    if (url.pathname === '/_auth/login') return
    const session = await getSession(request)
    if (!session) {
      if (request.method === 'GET' && request.headers['sec-fetch-dest'] === 'document') {
        return reply.redirect('/_auth/login', 303)
      }
      return reply.code(401).send('请先在 /_auth/login 登录')
    }
    if (url.pathname === '/connect' || url.searchParams.has('token')) reject(403, 'DSH credentials are private to the proxy')
    if (request.headers.upgrade?.toLowerCase() === 'websocket') {
      const token = session.session.id
      const expiry = session.session.expiresAt.getTime()
      const socket = request.raw.socket
      const group = sockets.get(token) ?? new Set<Socket>()
      group.add(socket)
      sockets.set(token, group)
      const expire = (): void => {
        const remaining = expiry - Date.now()
        if (remaining <= 0) { socket.destroy(); return }
        timer = setTimeout(expire, Math.min(remaining, 2_147_483_647))
        timer.unref()
      }
      let timer: NodeJS.Timeout | undefined
      expire()
      socket.once('close', () => {
        clearTimeout(timer)
        group.delete(socket)
        if (group.size === 0) sockets.delete(token)
      })
    }
    if (!url.pathname.startsWith('/_auth/') && upstream.expires <= Date.now() + 60_000) await renew()
    if (request.headers.upgrade?.toLowerCase() === 'websocket' && !await getSession(request)) reject(401, 'Session revoked')
  })
  app.get('/_auth/login', async (_request, reply) => {
    return reply.header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
      .type('text/html; charset=utf-8').send(LOGIN)
  })
  app.post('/_auth/login', async (request, reply) => {
    if (request.headers.origin !== origin.origin) reject(403, 'Origin required')
    const body = request.body
    if (typeof body !== 'object' || body === null || !('password' in body)
      || typeof body.password !== 'string' || body.password.length > 1024) reject(400, 'Invalid password field')
    const response = await authRequest(request, 'sign-in/email', { email: OWNER_EMAIL, password: body.password, rememberMe: true })
    if (!response.ok) return reply.code(response.status).type('text/plain; charset=utf-8')
      .send(response.status === 429 ? '登录尝试过多，请稍后重试' : '密码错误，请返回后重试')
    reply.header('set-cookie', response.headers.getSetCookie())
    return reply.redirect('/', 303)
  })
  app.get('/_auth/session', async () => ({ authenticated: true }))
  app.post('/_auth/logout', async (request, reply) => {
    if (request.headers.origin !== origin.origin) reject(403, 'Origin required')
    const session = await getSession(request)
    const response = await authRequest(request, 'sign-out', {})
    if (!response.ok) reject(response.status, 'Sign out failed')
    for (const socket of sockets.get(session?.session.id ?? '') ?? []) socket.destroy()
    return reply.header('set-cookie', response.headers.getSetCookie()).redirect('/_auth/login', 303)
  })

  const upstreamHeaders = (request: Pick<FastifyRequest, 'headers'>): IncomingHttpHeaders => {
    const headers: IncomingHttpHeaders = { ...request.headers }
    const blocked = new Set(['cookie', 'authorization', 'forwarded', 'referer', 'connection', 'proxy-authorization'])
    for (const name of (request.headers.connection ?? '').split(',')) blocked.add(name.trim().toLowerCase())
    for (const name of Object.keys(headers)) {
      if (blocked.has(name) || name.startsWith('x-forwarded-') || name.startsWith('sec-websocket-')) delete headers[name]
    }
    headers.host = new URL(upstream.origin).host
    headers.cookie = upstream.cookie
    if (request.headers.origin !== undefined) headers.origin = upstream.origin
    return headers
  }
  // The library's runtime supports this hook, but its exported WS options omit it.
  const wsClientOptions = {
    handshakeTimeout: 10_000,
    rewriteRequestHeaders: (_headers: IncomingHttpHeaders, request: FastifyRequest) => upstreamHeaders(request),
  }
  await app.register(proxy, {
    upstream: upstream.origin,
    websocket: true,
    wsClientOptions,
    retryMethods: [],
    maxRetriesOn503: 0,
    disableRequestLogging: true,
    replyOptions: {
      retriesCount: 0,
      onResponse: (_request, reply, response) => {
        if (response.statusCode === 401) upstream.expires = 0
        void reply.send(response.stream)
      },
      rewriteRequestHeaders: request => upstreamHeaders(request),
      rewriteHeaders: headers => {
        const result = { ...headers }
        delete result['set-cookie']
        result['cache-control'] = 'no-store'
        const location = result.location
        if (typeof location === 'string' && location.startsWith(upstream.origin + '/')) {
          result.location = origin.origin + location.slice(upstream.origin.length)
        }
        return result
      },
    },
  })
  app.setErrorHandler((error, _request, reply) => {
    const status = typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number'
      ? error.statusCode : 502
    if (status >= 500) console.error('Proxy operation failed; check DSH before retrying a change')
    void reply.code(status).send(status >= 500 ? 'DSH 暂不可用，请检查服务器后再重试' : error)
  })
  return app
}
