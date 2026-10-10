/** Default-deny listener gate with an exact anonymous login allowlist. */
import { AuthError } from '@hydrogen/dsh-browser-auth'
import type { WebRequestGate } from '@deepseek-ai/dsh-host-webserver'
import type { AuthOperations } from './operations.ts'
import { browserRequest } from './request.ts'

const PUBLIC_GET = new Set(['/auth/login', '/auth/client.js', '/auth/client.css', '/auth/state'])
// These handlers recheck admission after body reads and asynchronous work, then revoke before replying.
const SELF_REVOKING_POST = new Set(['/auth/logout', '/auth/logout-all', '/auth/password/change', '/auth/passkeys/delete'])
const PUBLIC_POST = new Set(['/auth/password/login', '/auth/passkey/options', '/auth/passkey/verify'])

/**
 * Protect every named route, static asset, fallback and protocol upgrade.
 * *
 * @param operations - initialized single-user authentication owner.
 * *
 * @returns a synchronous gate that never infers public routes from a prefix.
 */
export function createBrowserRequestGate(operations: AuthOperations): WebRequestGate {
  return (request, carrier) => {
    try {
      const facts = browserRequest(request)
      const admission = operations.authenticate(facts)
      const path = new URL(facts.url, operations.config.trustPolicy.publicOrigin).pathname
      const anonymous = carrier === 'http' && (
        ((facts.method === 'GET' || facts.method === 'HEAD') && PUBLIC_GET.has(path))
        || (facts.method === 'POST' && PUBLIC_POST.has(path))
      )
      if (admission !== undefined) {
        if (carrier === 'http' && facts.method === 'POST' && SELF_REVOKING_POST.has(path)) return { kind: 'allow' }
        return { kind: 'allow', admission }
      }
      if (anonymous) return { kind: 'allow' }
      const document = carrier === 'http' && (facts.method === 'GET' || facts.method === 'HEAD')
        && (request.headers['sec-fetch-dest'] === 'document' || request.headers.accept?.includes('text/html') === true)
      return document
        ? { kind: 'reject', status: 303, headers: { location: operations.config.trustPolicy.mountPath + 'auth/login' } }
        : { kind: 'reject', status: 401 }
    } catch (error) {
      return { kind: 'reject', status: error instanceof AuthError && error.code === 'auth/forbidden' ? 403 : 503 }
    }
  }
}
