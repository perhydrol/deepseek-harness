/** Browser authentication request facts and per-session admission. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Opaque browser session identity, independent of the operator Peer. */
export type BrowserSessionId = Branded<'browser-session-id'>
/** Header facts shared with existing transport adapters. */
export interface BrowserTrustRequest {
  readonly headers: Headers | Readonly<Record<string, string | readonly string[] | undefined>>
}
/** Facts supplied by the HTTP adapter, never by request JSON. */
export interface BrowserRequest extends BrowserTrustRequest {
  readonly method: string
  readonly url: string
  readonly remoteAddress: string | undefined
}
/** Admission ends on either revocation or the absolute deadline. */
export interface AdmissionLifetime {
  readonly sessionId: BrowserSessionId
  readonly expiresAt: number
  readonly revoked: AbortSignal
}
/** Result of synchronous browser authentication. */
export type BrowserAdmission =
  | { readonly kind: 'authenticated'; readonly lifetime: AdmissionLifetime }
  | { readonly kind: 'rejected'; readonly status: 401 | 403 }
/** Minimal response operations for authentication-owned index responses. */
export interface IndexResponse {
  writeHead(status: number, headers?: Readonly<Record<string, string>>): unknown
  end(body?: string): unknown
}
/** Validated deployment policy, independent of incoming forwarding headers. */
export type BrowserTrustPolicy =
  | { readonly mode: 'legacy-listener' }
  | {
    readonly mode: 'single-user'
    readonly publicOrigin: string
    readonly mountPath: string
    readonly upstream:
        | { readonly kind: 'direct' }
        | { readonly kind: 'proxy'; readonly trustedPeers: readonly string[]; readonly clientIpHeader: string }
  }
/** Public availability contains no stored credentials or session identifiers. */
export interface BrowserPublicState {
  readonly mode: 'launch-token' | 'single-user'
  readonly password: boolean
  readonly passkey: boolean
}
/** Authentication provider consumed by HTTP, index and WebSocket adapters. */
export interface BrowserAuthHandle {
  readonly trustPolicy: BrowserTrustPolicy
  /**
 * Return a live committed session for a valid bearer token.
 * @param request - transport-owned request facts.
 * @returns admission valid until its deadline or abort.
 */
  authenticate(request: BrowserRequest): BrowserAdmission
  /**
 * @param request - index request facts.
 * @param response - owned on false.
 * @returns whether index rendering may proceed.
 */
  authorizeIndex(request: BrowserRequest, response: IndexResponse): boolean
  /**
 * @param baseUrl - clean application URL.
 * @returns provider-specific browser entry URL.
 */
  authenticatedUrl(baseUrl: string): string
  /**
 * Report the authentication capabilities exposed to the browser.
 * @returns public login method availability without secrets.
 */
  getPublicState(): BrowserPublicState
}

/** Persisted scrypt parameters; parsers enforce costs before allocation. */
export interface PasswordRecord {
  readonly algorithm: 'scrypt'
  readonly N: number
  readonly r: number
  readonly p: number
  readonly maxmem: number
  readonly salt: string
  readonly hash: string
}

/** Opaque authenticator credential ID owned by the operator. */
export type PasskeyId = Branded<'browser-passkey-id'>
/** Canonical deployment binding stored with credentials. */
export interface AuthDeployment {
  readonly publicOrigin: string
  readonly rpId: string
  readonly mountPath: string
}
/** An active session; id is SHA-256 of its opaque bearer token. */
export interface BrowserSessionRecord {
  readonly id: BrowserSessionId
  readonly createdAt: number
  readonly expiresAt: number
  readonly generation: number
}
/** Persisted WebAuthn public credential and verification metadata. */
export interface PasskeyRecord {
  readonly id: PasskeyId
  readonly publicKey: string
  readonly counter: number
  readonly revision: number
  readonly transports: readonly ('ble' | 'cable' | 'hybrid' | 'internal' | 'nfc' | 'smart-card' | 'usb')[]
  readonly deviceType: 'singleDevice' | 'multiDevice'
  readonly backedUp: boolean
  readonly label: string
  readonly createdAt: number
  readonly lastUsedAt: number | null
}
/** Versioned singleton document, isolated from Session logs and model input. */
export interface AuthState {
  readonly schemaVersion: 1
  readonly revision: number
  readonly deployment: AuthDeployment
  readonly userHandle: string
  readonly password: PasswordRecord
  readonly csrfSecret: string
  readonly generation: number
  readonly passkeys: readonly PasskeyRecord[]
  readonly sessions: readonly BrowserSessionRecord[]
}
