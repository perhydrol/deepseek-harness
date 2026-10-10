/** Persistent bearer tokens and per-session revocation without separate operator identities. */
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { AuthError, BrowserSessionId } from '@hydrogen/dsh-browser-auth'
import type { AdmissionLifetime, AuthState, AuthStore, BrowserSessionId as SessionId } from '@hydrogen/dsh-browser-auth'

/** Validated deployment session lifetime and capacity. */
export interface SessionPolicy { readonly lifetimeMs: number; readonly limit: number }
interface LiveAdmission { readonly lifetime: AdmissionLifetime; readonly controller: AbortController; readonly timer: NodeJS.Timeout }

/** Instance-owned admissions reconstructed from committed session rows. */
export class SessionAdmissions {
  private readonly admissions = new Map<SessionId, LiveAdmission>()
  private readonly unsubscribe: () => void
  private stopped = false
  private readonly failed: () => void

  /**
 * @param store - exclusive initialized persistent store.
 * @param policy - resolved session budgets.
 */
  constructor(private readonly store: AuthStore<AuthState>, private readonly policy: SessionPolicy) {
    this.unsubscribe = store.subscribe((state) =>{  this.publish(state) })
    this.failed = () =>{  this.abortAll() }
    store.unavailable.addEventListener('abort', this.failed, { once: true })
    if (store.unavailable.aborted) this.abortAll()
    else this.publish(this.state())
  }

  /**
 * Create a bounded proof or session with an absolute lifetime.
 * @param now - admission time.
 * @returns raw token once and its committed admission lifetime.
 */
  create(now: number): { token: string; lifetime: AdmissionLifetime } {
    const token = randomBytes(32).toString('base64url')
    const id = tokenId(token)
    this.store.update((current) => {
      if (current === undefined) throw new AuthError('auth/not-initialized', 'Authentication is not initialized.')
      const sessions = current.sessions.filter(session => session.expiresAt > now)
      if (sessions.length >= this.policy.limit) {
        throw new AuthError('auth/capacity', 'Session limit reached; revoke another session before signing in.')
      }
      const record = { id, createdAt: now, expiresAt: now + this.policy.lifetimeMs, generation: current.generation }
      return { ...current, sessions: [...sessions, record] }
    })
    const lifetime = this.authenticate(token, now)
    if (lifetime === undefined) throw new AuthError('auth/unavailable', 'Committed session admission is unavailable.')
    return { token, lifetime }
  }

  /**
 * Return a live committed session for a valid bearer token.
 * @param token - untrusted bearer cookie.
 * @param now - dispatch time.
 * @returns live committed admission or absence.
 */
  authenticate(token: string, now: number): AdmissionLifetime | undefined {
    if (this.stopped || this.store.unavailable.aborted || !/^[A-Za-z0-9_-]{43}$/.test(token)) return undefined
    const state = this.state()
    const id = tokenId(token)
    const row = state.sessions.find(session => session.id === id && session.generation === state.generation && session.expiresAt > now)
    const admission = this.admissions.get(id)
    return row !== undefined && admission !== undefined && !admission.controller.signal.aborted ? admission.lifetime : undefined
  }

  /**
 * Derive the stable CSRF proof of a live browser session.
 * @param id - admitted session.
 * @returns stable session CSRF proof shared across tabs and reloads.
 */
  csrf(id: SessionId): string {
    const state = this.state()
    if (!state.sessions.some(session => session.id === id && session.expiresAt > Date.now())) {
      throw new AuthError('auth/invalid-credentials', 'The browser session has expired; sign in again.')
    }
    return createHmac('sha256', Buffer.from(state.csrfSecret, 'base64url')).update(id).digest('base64url')
  }

  /**
 * Revoke the current session and clear its Cookie.
 * @param id - session to revoke durably before returning success.
 */
  logout(id: SessionId): void {
    this.store.update((current) => {
      const state = this.requireState(current)
      return { ...state, sessions: state.sessions.filter(session => session.id !== id) }
    })
  }

  /** Abort admissions and release subscriptions before the store owner closes. */
  close(): void {
    this.unsubscribe()
    this.store.unavailable.removeEventListener('abort', this.failed)
    this.abortAll()
  }

  private requireState(state: Readonly<AuthState> | undefined): Readonly<AuthState> {
    if (this.stopped || state === undefined) throw new AuthError('auth/unavailable', 'Authentication state is unavailable.')
    return state
  }
  private state(): Readonly<AuthState> { return this.requireState(this.store.read()) }

  private publish(state: Readonly<AuthState>): void {
    const now = Date.now()
    for (const [id, admission] of this.admissions) {
      if (!state.sessions.some(session => session.id === id && session.generation === state.generation && session.expiresAt > now)) {
        clearTimeout(admission.timer)
        admission.controller.abort()
        this.admissions.delete(id)
      }
    }
    for (const session of state.sessions) {
      if (session.expiresAt <= now || this.admissions.has(session.id)) continue
      const controller = new AbortController()
      const lifetime = Object.freeze({ sessionId: session.id, expiresAt: session.expiresAt, revoked: controller.signal })
      const expire = () => {
        const remaining = session.expiresAt - Date.now()
        if (remaining > 0) {
          const admission = this.admissions.get(session.id)
          if (admission !== undefined) {
            const timer = setTimeout(expire, Math.min(remaining, 2147483647))
            timer.unref()
            this.admissions.set(session.id, { ...admission, timer })
          }
        } else {
          controller.abort()
          this.admissions.delete(session.id)
        }
      }
      const timer = setTimeout(expire, Math.min(session.expiresAt - now, 2147483647))
      timer.unref()
      this.admissions.set(session.id, { lifetime, controller, timer })
    }
  }

  private abortAll(): void {
    this.stopped = true
    for (const admission of this.admissions.values()) { clearTimeout(admission.timer); admission.controller.abort() }
    this.admissions.clear()
  }
}
function tokenId(token: string): SessionId { return BrowserSessionId(createHash('sha256').update(token).digest('base64url')) }
