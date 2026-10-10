/** Bounded per-client and global authentication attempt windows. */
import { AuthError } from '@hydrogen/dsh-browser-auth'

/** Deployment-owned fixed window and capacity budgets. */
export interface RateLimitPolicy {
  readonly windowMs: number
  readonly perClient: number
  readonly global: number
  readonly clients: number
}
interface Window { start: number; count: number }

/** Reject excess work before password or WebAuthn verification. */
export class AuthRateLimiter {
  private readonly clients = new Map<string, Window>()
  private global: Window = { start: 0, count: 0 }
  /**
 * @param policy - resolved instance window and count limits.
 */
  constructor(private readonly policy: RateLimitPolicy) {}

  /**
 * Charge one authentication attempt against the configured resource limits.
 * @param client - trusted normalized client identity.
 * @param now - monotonic observation of wall time.
 */
  admit(client: string, now: number): void {
    for (const [key, value] of this.clients) if (now >= value.start + this.policy.windowMs) this.clients.delete(key)
    if (now >= this.global.start + this.policy.windowMs) this.global = { start: now, count: 0 }
    let entry = this.clients.get(client)
    if (entry === undefined) {
      if (this.clients.size >= this.policy.clients) throw new AuthError('auth/busy', 'Authentication attempt capacity reached; try again later.')
      entry = { start: now, count: 0 }
      this.clients.set(client, entry)
    }
    if (entry.count >= this.policy.perClient || this.global.count >= this.policy.global) {
      throw new AuthError('auth/busy', 'Too many authentication attempts; try again later.')
    }
    entry.count += 1
    this.global.count += 1
  }
}
