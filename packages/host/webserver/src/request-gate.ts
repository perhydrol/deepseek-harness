/** Generic per-request admission decisions and revocable transport leases. */
import type { IncomingMessage } from 'node:http'

/** Absolute transport deadline and external revocation signal. */
export interface WebRequestAdmission {
  readonly expiresAt: number
  readonly revoked: AbortSignal
}
/** A gate may own an HTTP rejection without invoking any registered route. */
export type WebRequestGateDecision =
  | { readonly kind: 'allow'; readonly admission?: WebRequestAdmission }
  | { readonly kind: 'reject'; readonly status: 401 | 403 | 503 | 303; readonly headers?: Readonly<Record<string, string>> }
/** Runs before named routes, fallback handlers and protocol upgrades. */
export type WebRequestGate = (request: IncomingMessage, carrier: 'http' | 'upgrade') => WebRequestGateDecision

/**
 * Tie one transport to a revocable absolute deadline, including long lifetimes.
 * @param admission - gate-owned admission.
 * @param close - immediate carrier cancellation.
 * @returns cleanup to run on transport close.
 */
export function bindWebAdmission(admission: WebRequestAdmission, close: () => void): () => void {
  let timer: NodeJS.Timeout | undefined
  let stopped = false
  const revoke = () => {
    if (stopped) return
    close()
    dispose()
  }
  const expire = () => {
    const remaining = admission.expiresAt - Date.now()
    if (admission.revoked.aborted || remaining <= 0) revoke()
    else {
      timer = setTimeout(expire, Math.min(remaining, 2147483647))
      timer.unref()
    }
  }
  const dispose = () => {
    stopped = true
    clearTimeout(timer)
    admission.revoked.removeEventListener('abort', revoke)
  }
  admission.revoked.addEventListener('abort', revoke, { once: true })
  expire()
  return dispose
}
