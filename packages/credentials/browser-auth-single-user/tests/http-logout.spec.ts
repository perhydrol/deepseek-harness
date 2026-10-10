/** Logout replies finish after revocation while other admitted transports close. */
import { request } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { expect, it } from 'vitest'
import type { AuthState, AuthStore } from '@hydrogen/dsh-browser-auth'
import type { PasskeyId } from '@hydrogen/dsh-browser-auth'
import { resolveSingleUserConfig } from '../src/config.ts'
import { AuthOperations } from '../src/operations.ts'
import { initializeAuthState } from '../src/state.ts'
import { hashPassword } from '../src/password.ts'
import { registerAuthRoutes } from '../src/routes.ts'
import { createBrowserRequestGate } from '../src/request-gate.ts'

it.each(['logout', 'logout-all', 'password/change', 'passkeys/delete'])('delivers the success and cleared cookie after %s commits', async (operation) => {
  const config = resolveSingleUserConfig({ publicOrigin: 'https://harness.example', rpId: 'harness.example' })
  let state = initializeAuthState({ publicOrigin: 'https://harness.example', rpId: 'harness.example', mountPath: '/' },
    await hashPassword('private test password', config.password))
  state = { ...state, passkeys: [{ id: 'device-key' as PasskeyId, publicKey: 'AA', counter: 0, revision: 1,
    transports: ['internal'], deviceType: 'singleDevice', backedUp: false, label: 'Device', createdAt: Date.now(), lastUsedAt: null }] }
  const observers = new Set<(state: Readonly<AuthState>) => void>()
  const store: AuthStore<AuthState> = {
    unavailable: new AbortController().signal, read: () => state,
    update: (transform) => { state = transform(state); for (const observer of observers) observer(state); return state },
    subscribe: (observer) => { observers.add(observer); return () => { observers.delete(observer) } },
  }
  const ctx = new Context()
  const operations = new AuthOperations(store, config)
  let disposeRoutes: (() => Promise<void>) | undefined
  let disposeGate: (() => void) | undefined
  try {
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, requireRequestGate: true })
    disposeGate = ctx.webServer.registerRequestGate(createBrowserRequestGate(operations))
    disposeRoutes = registerAuthRoutes(ctx, operations)
    const call = (path: string, method = 'GET', cookie = '', csrf = '', body: object = {}) =>
      new Promise<{ status: number; cookies: string[]; body: Record<string, unknown> }>((resolve, reject) => {
        const outgoing = request({ host: '127.0.0.1', port: ctx.webServer.port, path, method, headers: {
          host: 'harness.example', origin: 'https://harness.example', cookie,
          'content-type': 'application/json', 'x-dsh-csrf': csrf,
        } }, (response) => {
          const chunks: Buffer[] = []
          response.on('data', (chunk: Buffer) => { chunks.push(chunk) })
          response.on('error', reject)
          response.on('end', () => { resolve({ status: response.statusCode ?? 0,
            cookies: response.headers['set-cookie'] ?? [],
            body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }) })
        })
        outgoing.on('error', reject)
        outgoing.end(method === 'POST' ? JSON.stringify(body) : undefined)
      })
    const before = await call('/auth/state')
    const preauth = before.cookies[0]?.split(';')[0] ?? ''
    const login = await call('/auth/password/login', 'POST', preauth, String(before.body.csrf), { password: 'private test password' })
    const cookie = login.cookies[0]?.split(';')[0] ?? ''
    const authenticated = await call('/auth/state', 'GET', cookie)
    let mutation: object = {}
    if (operation !== 'logout') {
      const reauth = await call('/auth/reauth/password', 'POST', cookie, String(authenticated.body.csrf), {
        password: 'private test password', action: operation === 'logout-all' ? 'logout-all' : operation === 'passkeys/delete' ? 'delete' : 'password',
        ...(operation === 'passkeys/delete' ? { target: 'device-key' } : {}),
      })
      mutation = operation === 'passkeys/delete' ? { grant: reauth.body.grant, id: 'device-key' } : operation === 'logout-all' ? { grant: reauth.body.grant }
        : { grant: reauth.body.grant, password: 'a different private password' }
    }
    const disposeHold = ctx.webServer.register({ kind: 'exact', path: '/hold', handler: (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('active')
    } })
    const hold = request({ host: '127.0.0.1', port: ctx.webServer.port, path: '/hold', headers: {
      host: 'harness.example', cookie,
    } })
    try {
      const opened = once(hold, 'response')
      hold.end()
      const [activeResponse] = await opened as [import('node:http').IncomingMessage]
      activeResponse.resume()
      let transportError: Error | undefined
      activeResponse.on('error', (error: Error) => { transportError = error })
      const closed = new Promise<undefined>((resolve) => { activeResponse.once('close', () => { resolve(undefined) }) })
      const beforeGeneration = state.generation
      const loggedOut = await call('/auth/' + operation, 'POST', cookie, String(authenticated.body.csrf), mutation)
      if (operation === 'passkeys/delete') {
        expect(state.generation).toBe(beforeGeneration + 1)
        expect(state.passkeys).toHaveLength(0)
      }
      await closed
      expect(activeResponse.complete).toBe(false)
      expect(transportError?.message).toBe('aborted')
      expect(loggedOut.status).toBe(200)
      expect(loggedOut.body.authenticated).toBe(false)
      expect(loggedOut.cookies[0]).toContain('Max-Age=0')
      expect(state.sessions).toHaveLength(0)
    } finally { hold.destroy(); disposeHold() }
  } finally {
    disposeGate?.()
    if (disposeRoutes !== undefined) await disposeRoutes()
    else await operations.close()
    await ctx.fiber.dispose()
  }
})
