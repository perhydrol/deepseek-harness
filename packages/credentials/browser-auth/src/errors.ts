/** Redacted authentication failures shared by route, storage and maintenance owners. */
/** Stable categories safe to expose without credential material. */
export type AuthFailureCode =
  | 'auth/password-policy' | 'auth/password-record' | 'auth/busy' | 'auth/unavailable'
  | 'auth/invalid-credentials' | 'auth/invalid-request' | 'auth/forbidden'
  | 'auth/capacity' | 'auth/challenge' | 'auth/reauth-required'
  | 'auth/storage' | 'auth/ownership' | 'auth/unsupported-platform' | 'auth/not-initialized'

/** Expected failure with a stable code and a secret-free diagnostic. */
export class AuthError extends Error {
  /**
 * @param code - handling category.
 * @param message - redacted operator guidance.
 * @param options - underlying cause.
 */
  constructor(readonly code: AuthFailureCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'AuthError'
  }
}
