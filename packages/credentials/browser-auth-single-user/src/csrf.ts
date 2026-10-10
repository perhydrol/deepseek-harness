/** Host-only authentication cookies; duplicate names are rejected. */
import { AuthError } from '@hydrogen/dsh-browser-auth'
import type { BrowserRequest } from '@hydrogen/dsh-browser-auth'
import { header } from './request.ts'

/**
 * Read one named Cookie and reject duplicate authentication Cookies.
 * @param request - incoming headers.
 * @param name - owned cookie name.
 * @returns opaque value or absence.
 */
export function cookieValue(request: BrowserRequest, name: string): string | undefined {
  const values = (header(request, 'cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(name + '='))
  if (values.length > 1) throw new AuthError('auth/invalid-request', 'Duplicate authentication cookie.')
  return values[0]?.slice(name.length + 1)
}

/**
 * Serialize a host-only authentication Cookie.
 * @param name - owned cookie name.
 * *
 * @param value - opaque base64url token.
 * *
 * @param secure - canonical public HTTPS.
 * *
 * @param age - seconds; zero deletes.
 * *
 * @returns Set-Cookie value.
 */
export function authCookie(name: string, value: string, secure: boolean, age: number): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(age)}${secure ? '; Secure' : ''}`
}
