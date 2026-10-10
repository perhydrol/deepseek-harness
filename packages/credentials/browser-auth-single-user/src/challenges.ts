/** Purpose-bound one-use authentication proofs with bounded storage. */
import { randomBytes } from 'node:crypto'
import { AuthError } from '@hydrogen/dsh-browser-auth'

/** Proof context prevents reuse across clients, sessions and credential generations. */
export interface ProofContext {
  readonly purpose: 'preauth' | 'login' | 'reauth' | 'register' | 'grant'
  readonly binding: string
  readonly generation: number
}
interface Proof<T> extends ProofContext { readonly expiresAt: number; readonly value: T }

/** Consume before asynchronous verification; invalid submissions cannot resurrect proofs. */
export class OneUseProofs<T> {
  private readonly entries = new Map<string, Proof<T>>()
  /**
 * @param limit - maximum live records.
 * @param lifetimeMs - absolute proof lifetime.
 */
  constructor(private readonly limit: number, private readonly lifetimeMs: number) {}

  /**
 * Create a bounded proof or session with an absolute lifetime.
 * @param context - operation and requester binding.
 * *
 * @param value - private verification data.
 * *
 * @param now - creation time.
 * *
 * @returns opaque proof ID.
 */
  create(context: ProofContext, value: T, now: number): string {
    this.prune(now)
    if (this.entries.size >= this.limit) throw new AuthError('auth/capacity', 'Authentication proof capacity reached; try again later.')
    const id = randomBytes(32).toString('base64url')
    this.entries.set(id, { ...context, value, expiresAt: now + this.lifetimeMs })
    return id
  }

  /**
 * Consume one proof bound to the supplied requester and purpose.
 * @param id - untrusted opaque proof.
 * *
 * @param context - required operation and requester.
 * *
 * @param now - consumption time.
 * *
 * @returns private verification data once.
 */
  consume(id: string, context: ProofContext, now: number): T {
    const proof = this.entries.get(id)
    this.entries.delete(id)
    if (proof === undefined || now >= proof.expiresAt || proof.purpose !== context.purpose
      || proof.binding !== context.binding || proof.generation !== context.generation) {
      throw new AuthError('auth/challenge', 'Authentication proof expired or was already used; start again.')
    }
    return proof.value
  }

  /**
 * Read a live proof without consuming it.
 * @param id - proof to inspect without consuming.
 * *
 * @param context - required requester context.
 * *
 * @param now - observation time.
 * *
 * @returns private data while the proof remains valid.
 */
  peek(id: string, context: ProofContext, now: number): T {
    const proof = this.entries.get(id)
    if (proof === undefined || now >= proof.expiresAt || proof.purpose !== context.purpose
      || proof.binding !== context.binding || proof.generation !== context.generation) {
      throw new AuthError('auth/challenge', 'Authentication proof expired; start again.')
    }
    return proof.value
  }

  /** Remove all process-local proofs during generation changes or shutdown. */
  clear(): void { this.entries.clear() }

  private prune(now: number): void {
    for (const [id, proof] of this.entries) if (now >= proof.expiresAt) this.entries.delete(id)
  }
}
