/** Security HTML and JSON remain reachable when the real page plugin is mounted. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import { BrowserAuthService } from '@hydrogen/dsh-browser-auth'
import type { BrowserAdmission, BrowserPublicState, BrowserTrustPolicy } from '@hydrogen/dsh-browser-auth'
import { apply } from '../src/index.ts'

vi.mock('node:fs/promises', async original => ({
  ...await original<typeof import('node:fs/promises')>(),
  readFile: vi.fn(async () => Buffer.from('/* authentication test asset */')),
}))

class TestBrowserAuth extends BrowserAuthService {
  readonly trustPolicy: BrowserTrustPolicy = { mode: 'single-user', publicOrigin: 'https://harness.example',
    mountPath: '/', upstream: { kind: 'direct' } }
  authenticate(): BrowserAdmission { return { kind: 'rejected', status: 401 } }
  authorizeIndex(): boolean { return false }
  authenticatedUrl(url: string): string { return url }
  getPublicState(): BrowserPublicState { return { mode: 'single-user', password: true, passkey: false } }
}

it('serves the security document and its JSON request without exposing either anonymously', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(WebServer, { host: '127.0.0.1', port: 0, requireRequestGate: true }).await()
    new TestBrowserAuth(ctx)
    ctx.effect(() => ctx.webServer.registerRequestGate(req => req.headers.cookie === 'test-session'
      ? { kind: 'allow' } : { kind: 'reject', status: 401 }))
    const jsonRoute = vi.fn((req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(req.url === '/auth/state'
        ? { authenticated: true, csrf: 'test-proof', password: true, passkey: false }
        : { passkeys: [], sessionCount: 1 }))
    })
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/auth', handler: jsonRoute }))
    await apply(ctx)
    const base = 'http://127.0.0.1:' + String(ctx.webServer.port)
    for (const path of ['/auth/security', '/auth/security/state']) {
      expect((await fetch(base + path)).status).toBe(401)
    }
    const document = await fetch(base + '/auth/security', { headers: { cookie: 'test-session' } })
    expect(document.status).toBe(200)
    expect(await document.text()).toContain('data-auth-mode="security"')
    const response = await fetch(base + '/auth/security/state', {
      method: 'POST', headers: { cookie: 'test-session', 'content-type': 'application/json', 'x-dsh-csrf': 'test-proof' },
      body: '{}',
    })
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ passkeys: [], sessionCount: 1 })
    expect(jsonRoute.mock.calls.at(-1)?.[0].url).toBe('/auth/security/state')
    expect(jsonRoute.mock.calls.at(-1)?.[0].headers['x-dsh-csrf']).toBe('test-proof')
  } finally { await ctx.fiber.dispose() }
})
