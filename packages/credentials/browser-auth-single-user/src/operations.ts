/** Single-operator authentication operations; persistent mutations precede success and cookies. */
import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import { AuthError } from '@hydrogen/dsh-browser-auth'
import type { AdmissionLifetime, AuthState, AuthStore, BrowserRequest } from '@hydrogen/dsh-browser-auth'
import type { ResolvedSingleUserConfig } from './config.ts'
import { OneUseProofs } from './challenges.ts'
import type { ProofContext } from './challenges.ts'
import { authCookie, cookieValue } from './csrf.ts'
import { assertMutationRequest, header, resolveRequestClient } from './request.ts'
import { PasswordHasher } from './password.ts'
import { SessionAdmissions } from './sessions.ts'
import { AuthRateLimiter } from './rate-limit.ts'
import { authenticationOptions, registrationOptions, verifyAssertion, verifyRegistration } from './webauthn.ts'
import { revokeAll } from './state.ts'

/** Authentication-owned JSON response and cookie writes. */
export interface AuthOperationResponse {
  readonly body: Record<string, unknown>
  readonly cookies: string[]
}
interface Challenge { readonly challenge: string; readonly action: string }
interface Reservation { readonly challenge: string; readonly grant: string; readonly label: string }
const string = z.string().max(1048576)
const action = z.enum(['register', 'delete', 'rename', 'password', 'logout-all'])
const passwordBody = z.strictObject({ password: string })
const assertionBody = z.strictObject({ id: string, response: z.unknown() })
const managementBody = z.strictObject({ action, target: string.default('') })
const reauthPassword = managementBody.extend({ password: string })
const reauthAssertion = managementBody.extend({ id: string, response: z.unknown() })
const registrationBody = z.strictObject({ grant: string, label: string })
const registrationFinish = z.strictObject({ id: string, response: z.unknown() })
const grantBody = z.strictObject({ grant: string })
const keyMutation = grantBody.extend({ id: string, label: string.optional() })
const passwordMutation = grantBody.extend({ password: string })

/** Request state and bounded asynchronous work owned by one provider instance. */
export class AuthOperations {
  /** Live admissions derived from committed persistent sessions. */
  readonly sessions: SessionAdmissions
  /** Host-only bearer Cookie name selected from the canonical public scheme. */
  readonly sessionCookie: string
  private readonly preauthCookie: string
  private readonly secure: boolean
  private readonly passwords: PasswordHasher
  private readonly preauth: OneUseProofs<string>
  private readonly challenges: OneUseProofs<Challenge>
  private readonly grants: OneUseProofs<string>
  private readonly registrations: OneUseProofs<Reservation>
  private readonly reserved = new Map<string, { id: string; expiresAt: number }>()
  private readonly attempts: AuthRateLimiter
  private readonly managementAttempts: AuthRateLimiter
  private readonly unsubscribe: () => void
  private stopped = false
  private generation: number

  /**
 * @param store - initialized exclusive store.
 * @param config - resolved deployment and budgets.
 */
  constructor(private readonly store: AuthStore<AuthState>, readonly config: ResolvedSingleUserConfig) {
    const state = this.state()
    if (JSON.stringify(state.deployment) !== JSON.stringify({
      publicOrigin: config.trustPolicy.publicOrigin, rpId: new URL(config.trustPolicy.publicOrigin).hostname,
      mountPath: config.trustPolicy.mountPath,
    })) throw new AuthError('auth/invalid-request', 'Authentication deployment differs from persisted credentials; stop the Host and reconfigure offline.')
    this.generation = state.generation
    this.secure = config.trustPolicy.publicOrigin.startsWith('https:')
    this.sessionCookie = this.secure ? '__Host-dsh_session' : 'dsh_session'
    this.preauthCookie = this.secure ? '__Host-dsh_preauth' : 'dsh_preauth'
    this.passwords = new PasswordHasher(config.password)
    this.sessions = new SessionAdmissions(store, { lifetimeMs: config.sessionLifetimeMs, limit: config.sessionLimit })
    this.preauth = new OneUseProofs(config.preauthLimit, config.preauthLifetimeMs)
    this.challenges = new OneUseProofs(config.challengeLimit, config.challengeLifetimeMs)
    this.grants = new OneUseProofs(config.challengeLimit, config.reauthLifetimeMs)
    this.registrations = new OneUseProofs(config.challengeLimit, config.challengeLifetimeMs)
    this.attempts = new AuthRateLimiter({
      windowMs: config.attemptWindowMs, perClient: config.attemptsPerClient,
      global: config.attemptsGlobal, clients: config.limiterClients,
    })
    this.managementAttempts = new AuthRateLimiter({
      windowMs: config.attemptWindowMs, perClient: config.managementAttempts,
      global: config.attemptsGlobal, clients: config.sessionLimit,
    })
    this.unsubscribe = store.subscribe((committed) => {
      if (committed.generation !== this.generation) {
        this.generation = committed.generation
        this.clearProofs()
      }
    })
  }

  /**
 * Return a live committed session for a valid bearer token.
 * @param request - transport facts.
 * @returns live persistent session or absence; rejects untrusted peers.
 */
  authenticate(request: BrowserRequest): AdmissionLifetime | undefined {
    resolveRequestClient(request, this.config.trustPolicy)
    const origin = header(request, 'origin')
    if (origin !== undefined && origin !== this.config.trustPolicy.publicOrigin) throw forbidden()
    const token = cookieValue(request, this.sessionCookie)
    return token === undefined ? undefined : this.sessions.authenticate(token, Date.now())
  }

  /**
 * Dispatch an owned authentication endpoint.
 * *
 * @param operation - path relative to the authentication route.
 * *
 * @param request - transport-owned HTTP facts.
 * *
 * @param body - bounded decoded JSON.
 * *
 * @returns response published only after committed mutations.
 */
  async execute(operation: string, request: BrowserRequest, body: unknown): Promise<AuthOperationResponse> {
    const client = resolveRequestClient(request, this.config.trustPolicy)
    const state = this.state()
    const session = this.authenticate(request)
    if (operation === 'state' && request.method === 'GET') {
      if (session !== undefined) return reply({
        authenticated: true, csrf: this.sessions.csrf(session.sessionId), password: true, passkey: state.passkeys.length > 0,
        expiresAt: session.expiresAt,
      })
      const context = this.context('preauth', client, state)
      const existing = cookieValue(request, this.preauthCookie)
      if (existing !== undefined) {
        try {
          return reply({ authenticated: false, csrf: this.preauth.peek(existing, context, Date.now()),
            password: true, passkey: state.passkeys.length > 0 })
        } catch (error) {
          if (!(error instanceof AuthError) || error.code !== 'auth/challenge') throw error
        }
      }
      const id = this.preauth.create(context, randomBytes(32).toString('base64url'), Date.now())
      return reply({
        authenticated: false, csrf: this.preauth.peek(id, context, Date.now()), password: true, passkey: state.passkeys.length > 0,
      },
      [this.cookie(this.preauthCookie, id, this.config.preauthLifetimeMs)])
    }
    if (session === undefined) return this.login(operation, request, body, client, state)
    assertMutationRequest(request, this.config.trustPolicy, this.sessions.csrf(session.sessionId))
    this.managementAttempts.admit(session.sessionId, Date.now())
    if (operation === 'logout') {
      this.sessions.logout(session.sessionId)
      return reply({ authenticated: false }, [this.cookie(this.sessionCookie, '', 0)])
    }
    if (operation === 'security/state') return reply({
      passkeys: state.passkeys.map(key => ({ id: key.id, label: key.label, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt })),
      sessionCount: state.sessions.filter(row => row.expiresAt > Date.now()).length,
    })
    if (operation === 'reauth/password') {
      const input = parse(reauthPassword, body)
      const target = actionTarget(input.action, input.target)
      if (!await this.passwords.verify(input.password, state.password)) throw credentials()
      this.assertUnchanged(state, session)
      return reply({ grant: this.grants.create(this.context('grant', session.sessionId, state), target, Date.now()) })
    }
    if (operation === 'reauth/passkey/options') {
      const input = parse(managementBody, body)
      const options = await authenticationOptions(state, this.config.challengeLifetimeMs)
      this.assertUnchanged(state, session)
      const id = this.challenges.create(this.context('reauth', session.sessionId, state),
        { challenge: options.challenge, action: actionTarget(input.action, input.target) }, Date.now())
      return reply({ id, options })
    }
    if (operation === 'reauth/passkey/verify') {
      const input = parse(reauthAssertion, body)
      const challenge = this.challenges.consume(input.id, this.context('reauth', session.sessionId, state), Date.now())
      const target = actionTarget(input.action, input.target)
      if (challenge.action !== target) throw forbidden()
      await this.assertPasskey(input.response, challenge.challenge, state, session)
      const current = this.state()
      return reply({ grant: this.grants.create(this.context('grant', session.sessionId, current), target, Date.now()) })
    }
    return this.manage(operation, body, session, state)
  }

  /** Refuse admissions and drain active password work before releasing the store. */
  async close(): Promise<void> {
    this.stopped = true
    this.unsubscribe()
    this.sessions.close()
    this.clearProofs()
    await this.passwords.close()
  }

  private async login(
    operation: string,
    request: BrowserRequest,
    body: unknown,
    client: string,
    state: Readonly<AuthState>,
  ): Promise<AuthOperationResponse> {
    const id = cookieValue(request, this.preauthCookie)
    if (id === undefined) throw credentials()
    const context = this.context('preauth', client, state)
    assertMutationRequest(request, this.config.trustPolicy, this.preauth.peek(id, context, Date.now()))
    this.attempts.admit(client, Date.now())
    if (operation === 'passkey/options') {
      const options = await authenticationOptions(state, this.config.challengeLifetimeMs)
      this.assertUnchanged(state)
      const challengeId = this.challenges.create(this.context('login', id, state), { challenge: options.challenge, action: 'login' }, Date.now())
      return reply({ id: challengeId, options })
    }
    this.preauth.consume(id, context, Date.now())
    if (operation === 'password/login') {
      const input = parse(passwordBody, body)
      if (!await this.passwords.verify(input.password, state.password)) throw credentials()
      this.assertUnchanged(state)
    } else if (operation === 'passkey/verify') {
      const input = parse(assertionBody, body)
      const challenge = this.challenges.consume(input.id, this.context('login', id, state), Date.now())
      await this.assertPasskey(input.response, challenge.challenge, state)
    } else throw new AuthError('auth/invalid-request', 'Unknown authentication operation.')
    const created = this.sessions.create(Date.now())
    return reply({ authenticated: true }, [
      this.cookie(this.sessionCookie, created.token, this.config.sessionLifetimeMs),
      this.cookie(this.preauthCookie, '', 0),
    ])
  }

  private async manage(
    operation: string,
    body: unknown,
    session: AdmissionLifetime,
    state: Readonly<AuthState>,
  ): Promise<AuthOperationResponse> {
    const context = this.context('grant', session.sessionId, state)
    if (operation === 'passkeys/register/options') {
      const input = parse(registrationBody, body)
      this.checkLabel(input.label)
      for (const [grant, reservation] of this.reserved) if (reservation.expiresAt <= Date.now()) this.reserved.delete(grant)
      if (this.reserved.has(input.grant) || this.grants.peek(input.grant, context, Date.now()) !== 'register') throw forbidden()
      if (state.passkeys.length >= this.config.passkeyLimit) throw new AuthError('auth/capacity', 'Passkey limit reached.')
      const options = await registrationOptions(state, this.config.challengeLifetimeMs)
      this.assertUnchanged(state, session)
      if (this.reserved.has(input.grant) || this.grants.peek(input.grant, context, Date.now()) !== 'register') throw forbidden()
      const id = this.registrations.create(this.context('register', session.sessionId, state),
        { challenge: options.challenge, grant: input.grant, label: input.label }, Date.now())
      this.reserved.set(input.grant, { id, expiresAt: Date.now() + this.config.challengeLifetimeMs })
      return reply({ id, options })
    }
    if (operation === 'passkeys/register/cancel') {
      const input = parse(z.strictObject({ id: string }), body)
      const reservation = this.registrations.consume(input.id, this.context('register', session.sessionId, state), Date.now())
      this.reserved.delete(reservation.grant)
      this.grants.peek(reservation.grant, context, Date.now())
      return reply({ cancelled: true })
    }
    if (operation === 'passkeys/register/verify') {
      const input = parse(registrationFinish, body)
      const reservation = this.registrations.consume(input.id, this.context('register', session.sessionId, state), Date.now())
      this.reserved.delete(reservation.grant)
      if (this.grants.consume(reservation.grant, context, Date.now()) !== 'register') throw forbidden()
      const key = await verifyRegistration(input.response, reservation.challenge, state, reservation.label, Date.now())
      this.assertUnchanged(state, session)
      this.store.update((current) => {
        const latest = requireState(current)
        if (latest.passkeys.some(existing => existing.id === key.id) || latest.passkeys.length >= this.config.passkeyLimit) {
          throw new AuthError('auth/capacity', 'Passkey already exists or capacity was reached.')
        }
        return { ...latest, passkeys: [...latest.passkeys, key] }
      })
      return reply({ registered: true })
    }
    if (operation === 'passkeys/delete' || operation === 'passkeys/rename') {
      const input = parse(keyMutation, body)
      const expected = actionTarget(operation.endsWith('delete') ? 'delete' : 'rename', input.id)
      this.consumeGrant(input.grant, expected, context)
      if (operation.endsWith('rename')) this.checkLabel(input.label ?? '')
      this.store.update((current) => {
        const latest = requireState(current)
        if (!latest.passkeys.some(key => key.id === input.id)) throw new AuthError('auth/invalid-request', 'Passkey is unavailable.')
        const next = { ...latest, passkeys: operation.endsWith('delete')
          ? latest.passkeys.filter(key => key.id !== input.id)
          : latest.passkeys.map(key => key.id === input.id ? { ...key, label: input.label ?? '', revision: key.revision + 1 } : key) }
        return operation.endsWith('delete') ? revokeAll(next) : next
      })
      return operation.endsWith('delete')
        ? reply({ authenticated: false }, [this.cookie(this.sessionCookie, '', 0)]) : reply({ updated: true })
    }
    if (operation === 'password/change') {
      const input = parse(passwordMutation, body)
      this.consumeGrant(input.grant, 'password', context)
      const password = await this.passwords.hash(input.password)
      this.assertUnchanged(state, session)
      this.store.update(current => revokeAll({ ...requireState(current), password }))
      return reply({ authenticated: false }, [this.cookie(this.sessionCookie, '', 0)])
    }
    if (operation === 'logout-all') {
      const input = parse(grantBody, body)
      this.consumeGrant(input.grant, 'logout-all', context)
      this.store.update(current => revokeAll(requireState(current)))
      return reply({ authenticated: false }, [this.cookie(this.sessionCookie, '', 0)])
    }
    throw new AuthError('auth/invalid-request', 'Unknown authentication operation.')
  }

  private consumeGrant(id: string, action: string, context: ProofContext): void {
    if (this.reserved.has(id) || this.grants.consume(id, context, Date.now()) !== action) throw forbidden()
  }

  private async assertPasskey(
    response: unknown,
    challenge: string,
    state: Readonly<AuthState>,
    session?: AdmissionLifetime,
  ): Promise<void> {
    const verified = await verifyAssertion(response, challenge, state)
    this.assertUnchanged(state, session)
    this.store.update((current) => {
      const latest = requireState(current)
      const key = latest.passkeys.find(candidate => candidate.id === verified.credential.id)
      if (key === undefined || key.revision !== verified.credential.revision) throw credentials()
      return { ...latest, passkeys: latest.passkeys.map(candidate => candidate.id === key.id ? {
        ...candidate, counter: verified.info.newCounter, revision: candidate.revision + 1,
        deviceType: verified.info.credentialDeviceType, backedUp: verified.info.credentialBackedUp, lastUsedAt: Date.now(),
      } : candidate) }
    })
  }

  private assertUnchanged(before: Readonly<AuthState>, session?: AdmissionLifetime): void {
    const current = this.state()
    if (current.generation !== before.generation || current.password.hash !== before.password.hash
      || (session !== undefined && (session.revoked.aborted || Date.now() >= session.expiresAt
        || !current.sessions.some(row => row.id === session.sessionId)))) throw credentials()
  }
  private checkLabel(label: string): void {
    if (label.trim().length === 0 || Buffer.byteLength(label, 'utf8') > this.config.labelLimitBytes) {
      throw new AuthError('auth/invalid-request', 'Passkey label is empty or exceeds the configured byte limit.')
    }
  }
  private cookie(name: string, value: string, lifetimeMs: number): string { return authCookie(name, value, this.secure, lifetimeMs / 1000) }
  private context(purpose: ProofContext['purpose'], binding: string, state: Readonly<AuthState>): ProofContext {
    return { purpose, binding, generation: state.generation }
  }
  private state(): Readonly<AuthState> {
    if (this.stopped) throw new AuthError('auth/unavailable', 'Authentication is stopping.')
    return requireState(this.store.read())
  }
  private clearProofs(): void {
    this.preauth.clear(); this.challenges.clear(); this.grants.clear(); this.registrations.clear(); this.reserved.clear()
  }
}
function requireState(state: Readonly<AuthState> | undefined): Readonly<AuthState> {
  if (state === undefined) throw new AuthError('auth/not-initialized', 'Initialize authentication offline before starting the Host.')
  return state
}
function actionTarget(action: string, target: string): string { return target === '' ? action : action + ':' + target }
function credentials(): AuthError { return new AuthError('auth/invalid-credentials', 'Authentication failed; sign in again.') }
function forbidden(): AuthError { return new AuthError('auth/forbidden', 'Authentication request is not allowed.') }
function reply(body: Record<string, unknown>, cookies: string[] = []): AuthOperationResponse { return { body, cookies } }
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new AuthError('auth/invalid-request', 'Authentication request fields are invalid.')
  return result.data
}
