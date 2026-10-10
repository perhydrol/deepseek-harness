/** Standalone authentication transport; private proofs live only in this instance. */
import z from 'zod'
import { startAuthentication, startRegistration, browserSupportsWebAuthn } from '@simplewebauthn/browser'

const stateSchema = z.object({ authenticated: z.boolean(), csrf: z.string().min(1), password: z.boolean(), passkey: z.boolean(),
  expiresAt: z.number().positive().optional() })
const success = z.looseObject({})
const grantSchema = z.object({ grant: z.string().min(1) })
const descriptor = z.object({ id: z.string(), type: z.literal('public-key'),
  transports: z.array(z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])) })
const assertionSchema = z.object({ id: z.string(), options: z.object({
  challenge: z.string(), rpId: z.string(), timeout: z.number(), userVerification: z.literal('required'),
}) })
const registrationSchema = z.object({ id: z.string(), options: z.object({
  challenge: z.string(), rp: z.object({ id: z.string(), name: z.string() }),
  user: z.object({ id: z.string(), name: z.string(), displayName: z.string() }), timeout: z.number(),
  pubKeyCredParams: z.array(z.object({ type: z.literal('public-key'), alg: z.number() })),
  attestation: z.literal('none'), excludeCredentials: z.array(descriptor),
  authenticatorSelection: z.object({ residentKey: z.literal('required'), requireResidentKey: z.literal(true),
    userVerification: z.literal('required') }), extensions: z.object({ credProps: z.literal(true) }),
}) })
const securitySchema = z.object({ sessionCount: z.number().int().nonnegative(), passkeys: z.array(z.object({
  id: z.string(), label: z.string(), createdAt: z.number(), lastUsedAt: z.number().nullable(),
})) })
/** Public state returned by the login-only bootstrap. */
export type AuthPageState = z.infer<typeof stateSchema>
/** Redacted credential metadata for the security page. */
export type SecurityState = z.infer<typeof securitySchema>
/** Sensitive operations each consume one narrowly scoped reauthentication grant. */
export type ManagementAction = 'register' | 'delete' | 'rename' | 'password' | 'logout-all'
/** Proof method selected explicitly by the operator. */
export type Reauthentication = { readonly method: 'password'; readonly password: string } | { readonly method: 'passkey' }

/** UI-local error discriminant; server diagnostics and secrets never become page copy. */
export class AuthPageError extends Error {
  constructor(readonly code: string) { super(code) }
}

/** State and mutation client shared by the public login and authenticated security pages. */
export class AuthClient {
  /** Latest parsed browser state; proofs stay in this page instance. */
  state: AuthPageState | undefined
  constructor(readonly mountPath: string, private readonly fetcher: typeof fetch = fetch) {}

  /**
 * Refresh browser authentication state and its CSRF proof.
 * @returns freshly parsed session state and an in-memory CSRF proof.
 */
  async refresh(): Promise<AuthPageState> {
    this.state = await this.request('state', undefined, stateSchema)
    return this.state
  }

  /**
 * Exchange an exact password and preauthentication proof for a session.
 * @param password - exact untrimmed password.
 * @returns after the session Cookie is accepted.
 */
  async loginPassword(password: string): Promise<void> {
    await this.login(() => this.request('password/login', { password }, success))
  }

  /**
 * Run a discoverable passkey ceremony and establish a session.
 * @returns after discoverable user-verified authentication and session creation.
 */
  async loginPasskey(): Promise<void> {
    await this.login(async () => {
      this.requireWebAuthn()
      const challenge = await this.request('passkey/options', {}, assertionSchema)
      const response = await startAuthentication({ optionsJSON: challenge.options })
      return this.request('passkey/verify', { id: challenge.id, response }, success)
    })
  }

  /**
 * Read redacted credential metadata for the security page.
 * @returns redacted key metadata and active-session count.
 */
  async security(): Promise<SecurityState> { return this.request('security', {}, securitySchema) }

  /**
 * Revoke the current session and clear its Cookie.
 * @returns after current-session revocation and Cookie clearing commit.
 */
  async logout(): Promise<void> { await this.request('logout', {}, success); this.state = undefined }

  /**
 * Obtain a one-use grant bound to the requested action and key.
 * *
 * @param action - sensitive operation.
 * *
 * @param proof - password or explicit passkey ceremony.
 * *
 * @param target - key ID for rename/delete, otherwise empty.
 * *
 * @returns an opaque grant kept only for the immediately following operation.
 */
  async reauthenticate(action: ManagementAction, proof: Reauthentication, target = ''): Promise<string> {
    if (proof.method === 'password') return (await this.request('reauth/password',
      { action, target, password: proof.password }, grantSchema)).grant
    this.requireWebAuthn()
    const challenge = await this.request('reauth/passkey/options', { action, target }, assertionSchema)
    const response = await startAuthentication({ optionsJSON: challenge.options })
    return (await this.request('reauth/passkey/verify', { action, target, id: challenge.id, response }, grantSchema)).grant
  }

  /**
 * Register a discoverable user-verified credential; cancellation releases its reservation.
 * *
 * @param grant - fresh registration grant.
 * *
 * @param label - operator-visible device label.
 */
  async register(grant: string, label: string): Promise<void> {
    this.requireWebAuthn()
    const challenge = await this.request('passkeys/register/options', { grant, label }, registrationSchema)
    let response: Awaited<ReturnType<typeof startRegistration>>
    try { response = await startRegistration({ optionsJSON: challenge.options }) } catch (error) {
      await this.request('passkeys/register/cancel', { id: challenge.id }, success)
      throw ceremonyError(error)
    }
    await this.request('passkeys/register/verify', { id: challenge.id, response }, success)
  }

  /**
 * Rename the selected passkey using one action-bound grant.
 * @param id - persisted key ID.
 * @param grant - key-bound proof.
 * @param label - replacement label.
 */
  async rename(id: string, grant: string, label: string): Promise<void> {
    await this.request('passkeys/rename', { id, grant, label }, success)
  }
  /**
 * Remove the selected passkey and revoke all sessions.
 * @param id - persisted key ID.
 * @param grant - key-bound proof.
 */
  async delete(id: string, grant: string): Promise<void> {
    await this.request('passkeys/delete', { id, grant }, success); this.state = undefined
  }
  /**
 * Replace the password and revoke every browser session.
 * @param grant - password-change proof.
 * @param password - exact replacement password.
 */
  async changePassword(grant: string, password: string): Promise<void> {
    await this.request('password/change', { grant, password }, success); this.state = undefined
  }
  /**
 * Revoke every browser session using a fresh grant.
 * @param grant - global-revocation proof.
 */
  async logoutAll(grant: string): Promise<void> { await this.request('logout-all', { grant }, success); this.state = undefined }

  private requireWebAuthn(): void {
    if (!browserSupportsWebAuthn() || !globalThis.isSecureContext) throw new AuthPageError('auth/unsupported')
  }
  private async login(run: () => Promise<unknown>): Promise<void> {
    try { await run(); await this.refresh() } catch (error) {
      this.state = undefined
      try { await this.refresh() } catch (_refreshError) { /* The original failure owns the visible retry instruction. */ }
      throw ceremonyError(error)
    }
  }
  private async request<T>(operation: string, body: object | undefined, schema: z.ZodType<T>): Promise<T> {
    let response: Response
    try {
      const fetcher = this.fetcher
      response = await fetcher(this.mountPath + 'auth/' + operation, {
        method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { accept: 'application/json', ...(body === undefined ? {} : {
          'content-type': 'application/json', 'x-dsh-csrf': this.state?.csrf ?? '',
        }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
    } catch (_networkError) { throw new AuthPageError('auth/network') }
    let value: unknown
    try { value = await response.json() } catch (_jsonError) { throw new AuthPageError('auth/unavailable') }
    if (!response.ok) {
      const parsed = z.object({ error: z.object({ code: z.string() }) }).safeParse(value)
      throw new AuthPageError(parsed.success ? parsed.data.error.code : 'auth/unavailable')
    }
    const parsed = schema.safeParse(value)
    if (!parsed.success) throw new AuthPageError('auth/unavailable')
    return parsed.data
  }
}

function ceremonyError(error: unknown): Error {
  if (error instanceof AuthPageError) return error
  if (error instanceof Error) {
    const cause = error.cause instanceof Error ? error.cause : error
    if (cause.name === 'NotAllowedError' || cause.name === 'AbortError') return new AuthPageError('auth/cancelled')
    if (cause.name === 'NotSupportedError') return new AuthPageError('auth/unsupported')
  }
  return new AuthPageError('auth/invalid-credentials')
}
