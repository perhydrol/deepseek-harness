/** Default browser authentication provider for Web and Desktop profiles. */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BrowserAuthService } from '@hydrogen/dsh-browser-auth'
import type { BrowserAdmission, BrowserPublicState, BrowserRequest, IndexResponse } from '@hydrogen/dsh-browser-auth'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { BrowserAuth } from './launch-token.ts'

/** Provider name used in composed profiles. */
export const name = 'browser-auth-launch-token'
/** Signing records must be available before authentication activates. */
export const inject = ['credentials']
/** Absolute lifetime for signed browser cookies. */
export interface LaunchTokenConfig {
  /** Browser Cookie lifetime in days. */
  cookieMaxAgeDays?: number
}
/** Deployment-validated launch provider settings. */
export const Config: z<LaunchTokenConfig> = z.object({ cookieMaxAgeDays: z.natural().min(1).default(30) })

class LaunchTokenProvider extends BrowserAuthService {
  readonly trustPolicy = { mode: 'legacy-listener' } as const
  constructor(ctx: Context, private readonly auth: BrowserAuth) {
    super(ctx)
    ctx.effect(() => () => { auth.dispose() }, 'browser-auth-launch-token: admissions')
  }
  authenticate(request: BrowserRequest): BrowserAdmission {
    return this.auth.authenticate(request, this.ctx.get('webServer')?.protocol === 'https:')
  }
  authorizeIndex(request: BrowserRequest, response: IndexResponse): boolean {
    return this.auth.authorizeIndex(request, response, this.ctx.get('webServer')?.protocol === 'https:')
  }
  authenticatedUrl(baseUrl: string): string { return this.auth.authenticatedUrl(baseUrl) }
  getPublicState(): BrowserPublicState { return this.auth.getPublicState() }
}

/**
 * Activate the process launch-token provider with its persisted signing secret.
 * *
 * @param ctx - provider context containing credential storage.
 * *
 * @param config - cookie lifetime configuration.
 */
export async function apply(ctx: Context, config: LaunchTokenConfig = {}): Promise<void> {
  const auth = await BrowserAuth.create(ctx.root, ctx.credentials, config.cookieMaxAgeDays ?? 30)
  new LaunchTokenProvider(ctx, auth)
}
