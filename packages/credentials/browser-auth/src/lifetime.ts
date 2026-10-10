/** Synchronous admission checks independent of timer delivery. */
import type { AdmissionLifetime } from './types.ts'

/**
 * Check both revocation and the absolute deadline.
 * *
 * @param lifetime - admitted session's deadline and revocation signal.
 * *
 * @param now - current epoch time in milliseconds.
 * *
 * @returns whether a new operation may dispatch.
 */
export function isAdmissionLive(lifetime: Pick<AdmissionLifetime, 'expiresAt' | 'revoked'>, now: number): boolean {
  return !lifetime.revoked.aborted && now < lifetime.expiresAt
}
