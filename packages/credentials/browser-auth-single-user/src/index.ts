/** Optional Linux single-operator password and passkey browser authentication provider. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { AuthError, BrowserAuthService } from '@hydrogen/dsh-browser-auth'
import type { BrowserAdmission, BrowserPublicState, BrowserRequest, IndexResponse } from '@hydrogen/dsh-browser-auth'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@hydrogen/dsh-browser-auth-store-sqlite'
import { resolveSingleUserConfig } from './config.ts'
import type { SingleUserConfig } from './config.ts'
import { AuthOperations } from './operations.ts'
import { createBrowserRequestGate } from './request-gate.ts'
import { registerAuthRoutes } from './routes.ts'

/** Optional provider identity used by the single-user bundle. */
export const name = 'browser-auth-single-user'
/** Storage must be initialized offline and exclusively owned before activation. */
export const inject = ['browserAuthStore', 'webServer']
/** Deployment configuration validated before resolving defaults. */
export const Config: z<SingleUserConfig> = z.object({
  publicOrigin: z.string().required(), rpId: z.string().required(),
  mountPath: z.string(), development: z.boolean(),
  upstream: z.union([
    z.object({ kind: z.const('direct') }),
    z.object({ kind: z.const('proxy'), trustedPeers: z.array(z.string()).required(), clientIpHeader: z.string().required() }),
  ]),
  password: z.object({
    minimumBytes: z.natural(), maximumBytes: z.natural(), N: z.natural(), r: z.natural(), p: z.natural(),
    maxmem: z.natural(), activeLimit: z.natural(), queueLimit: z.natural(),
  }),
  sessionLifetimeMs: z.natural(), sessionLimit: z.natural(), passkeyLimit: z.natural(),
  challengeLifetimeMs: z.natural(), challengeLimit: z.natural(), preauthLifetimeMs: z.natural(), preauthLimit: z.natural(),
  reauthLifetimeMs: z.natural(), bodyLimitBytes: z.natural(), labelLimitBytes: z.natural(),
  attemptWindowMs: z.natural(), attemptsPerClient: z.natural(), attemptsGlobal: z.natural(),
  limiterClients: z.natural(), managementAttempts: z.natural(),
})
export type { SingleUserConfig } from './config.ts'

class SingleUserProvider extends BrowserAuthService {
  readonly trustPolicy
  constructor(ctx: Context, private readonly operations: AuthOperations) {
    super(ctx )
    this.trustPolicy = operations.config.trustPolicy
    ctx.effect(() => registerAuthRoutes(ctx, operations), 'browser-auth-single-user: routes and work')
  }
  authenticate(request: BrowserRequest): BrowserAdmission {
    try {
      const lifetime = this.operations.authenticate(request)
      return lifetime === undefined ? { kind: 'rejected', status: 401 } : { kind: 'authenticated', lifetime }
    } catch (error) {
      if (error instanceof AuthError && error.code === 'auth/forbidden') return { kind: 'rejected', status: 403 }
      throw error
    }
  }
  authorizeIndex(request: BrowserRequest, response: IndexResponse): boolean {
    const admission = this.authenticate(request)
    if (admission.kind === 'authenticated') return true
    if (admission.status === 403) { response.writeHead(403, { 'cache-control': 'no-store' }); response.end(); return false }
    response.writeHead(303, { location: this.trustPolicy.mountPath + 'auth/login', 'cache-control': 'no-store' })
    response.end()
    return false
  }
  authenticatedUrl(_baseUrl: string): string { return this.trustPolicy.publicOrigin + this.trustPolicy.mountPath }
  getPublicState(): BrowserPublicState { return { mode: 'single-user', password: true, passkey: true } }
}

/**
 * Activate a Linux provider without changing the default launch-token profile.
 * *
 * @param ctx - initialized storage and HTTP services.
 * *
 * @param config - canonical public origin, proxy trust and resource budgets.
 */
export function apply(ctx: Context, config: SingleUserConfig): void {
  if (process.platform !== 'linux') throw new AuthError('auth/unsupported-platform', 'Single-user authentication backend requires Linux.')
  const resolved = resolveSingleUserConfig(config)
  if (resolved.trustPolicy.upstream.kind === 'direct' && resolved.trustPolicy.publicOrigin.startsWith('https:')
    && ctx.webServer.protocol !== 'https:') {
    throw new AuthError('auth/invalid-request', 'Direct HTTPS authentication requires listener TLS; configure explicit proxy trust for an HTTP upstream.')
  }
  if (!ctx.webServer.requiresRequestGate) {
    throw new AuthError('auth/invalid-request', 'Single-user authentication requires webserver requireRequestGate: true for startup and unload protection.')
  }
  const operations = new AuthOperations(ctx.browserAuthStore.store, resolved)
  ctx.effect(() => ctx.webServer.registerRequestGate(createBrowserRequestGate(operations)), 'browser-auth-single-user: listener gate')
  new SingleUserProvider(ctx, operations)
}

export { resolveSingleUserConfig } from './config.ts'
export { hashPassword } from './password.ts'
export { initializeAuthState } from './state.ts'
export { reconfigureAuth, resetPassword } from './maintenance.ts'
