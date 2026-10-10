/** Login proofs are one-use and session revocations commit before successful responses. */
import { expect, it } from 'vitest'
import { IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { createBrowserRequestGate } from '../src/request-gate.ts'
import { AuthOperations } from '../src/operations.ts'
import { resolveSingleUserConfig } from '../src/config.ts'
import { initializeAuthState } from '../src/state.ts'
import { hashPassword } from '../src/password.ts'
import type { AuthState, AuthStore, BrowserRequest } from '@hydrogen/dsh-browser-auth'

it('requires pre-auth CSRF, consumes it on login and keeps the session proof stable', async () => {
  const config = resolveSingleUserConfig({ publicOrigin: 'https://harness.example', rpId: 'harness.example' })
  let state = initializeAuthState({ publicOrigin: 'https://harness.example', rpId: 'harness.example', mountPath: '/' },
    await hashPassword('private test password', config.password))
  const observers = new Set<(state: Readonly<AuthState>) => void>()
  const store: AuthStore<AuthState> = {
    unavailable: new AbortController().signal, read: () => state,
    update: (transform) => { state = transform(state); for (const observer of observers) observer(state); return state },
    subscribe: (observer) => { observers.add(observer); return () => { observers.delete(observer) } },
  }
  const operations = new AuthOperations(store, config)
  const request = (method: string, extra: Record<string, string> = {}): BrowserRequest => ({
    method, url: '/auth/state', remoteAddress: '127.0.0.1', headers: {
      host: 'harness.example', origin: 'https://harness.example', 'content-type': 'application/json', ...extra,
    },
  })
  const socket = new Socket()
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1' })
  const gate = createBrowserRequestGate(operations)
  const gateRequest = (path: string, method = 'GET', cookie?: string) => {
    const message = new IncomingMessage(socket)
    message.url = path
    message.method = method
    message.headers = { host: 'harness.example', ...(cookie === undefined ? {} : { cookie }) }
    return message
  }
  try {
    for (const path of ['/auth/login', '/auth/client.js', '/auth/client.css', '/auth/state']) {
      expect(gate(gateRequest(path), 'http')).toEqual({ kind: 'allow' })
      expect(gate(gateRequest(path), 'upgrade')).toEqual({ kind: 'reject', status: 401 })
    }
    for (const path of ['/auth/password/login', '/auth/passkey/options', '/auth/passkey/verify']) {
      expect(gate(gateRequest(path, 'POST'), 'http')).toEqual({ kind: 'allow' })
      expect(gate(gateRequest(path), 'http')).toEqual({ kind: 'reject', status: 401 })
    }
    for (const path of ['/', '/api', '/plugins/private.js', '/auth/security', '/auth/login/private', '/auth/%6cogin']) {
      expect(gate(gateRequest(path), 'http')).toEqual({ kind: 'reject', status: 401 })
    }
    const foreignOrigin = gateRequest('/auth/login')
    foreignOrigin.headers.origin = 'https://other.example'
    expect(gate(foreignOrigin, 'http')).toEqual({ kind: 'reject', status: 403 })
    const before = await operations.execute('state', request('GET'), {})
    expect(before.body.authenticated).toBe(false)
    const otherTab = await operations.execute('state', request('GET', { cookie: before.cookies[0]?.split(';')[0] ?? '' }), {})
    expect(otherTab.body.csrf).toBe(before.body.csrf)
    expect(otherTab.cookies).toEqual([])
    const proof = String(before.body.csrf)
    const cookie = before.cookies[0]?.split(';')[0] ?? ''
    const loggedIn = await operations.execute('password/login', request('POST', { cookie, 'x-dsh-csrf': proof }), { password: 'private test password' })
    expect(state.sessions).toHaveLength(1)
    await expect(operations.execute('password/login', request('POST', { cookie, 'x-dsh-csrf': proof }), { password: 'private test password' })).rejects.toThrow()
    const sessionCookie = loggedIn.cookies[0]?.split(';')[0] ?? ''
    expect(gate(gateRequest('/plugins/private.js', 'GET', sessionCookie), 'http').kind).toBe('allow')
    expect(gate(gateRequest('/socket', 'GET', sessionCookie), 'upgrade').kind).toBe('allow')
    const sessionState = await operations.execute('state', request('GET', { cookie: sessionCookie }), {})
    const reloaded = await operations.execute('state', request('GET', { cookie: sessionCookie }), {})
    expect(sessionState.body.csrf).toBe(reloaded.body.csrf)
    await operations.execute('logout', request('POST', { cookie: sessionCookie, 'x-dsh-csrf': String(sessionState.body.csrf) }), {})
    expect(state.sessions).toHaveLength(0)
    expect(gate(gateRequest('/api', 'GET', sessionCookie), 'http')).toEqual({ kind: 'reject', status: 401 })
    expect((await operations.execute('state', request('GET', { cookie: sessionCookie }), {})).body.authenticated).toBe(false)
  } finally { socket.destroy(); await operations.close() }
})
