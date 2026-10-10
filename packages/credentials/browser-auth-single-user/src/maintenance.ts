/** Offline recovery transitions always revoke sessions and rotate CSRF state. */
import { randomBytes } from 'node:crypto'
import { AuthError } from '@hydrogen/dsh-browser-auth'
import type { AuthDeployment, AuthState, PasswordRecord } from '@hydrogen/dsh-browser-auth'
import { revokeAll } from './state.ts'

/**
 * Reset credentials in one exclusively owned offline transaction.
 * *
 * @param state - restored or current committed singleton.
 * *
 * @param password - newly hashed exact password.
 * *
 * @param clearPasskeys - explicit deletion of registered public credentials.
 * *
 * @returns replacement invalidating every copied session token.
 */
export function resetPassword(state: Readonly<AuthState>, password: PasswordRecord, clearPasskeys: boolean): AuthState {
  return revokeAll({ ...state, password, passkeys: clearPasskeys ? [] : state.passkeys })
}

/**
 * Bind existing authentication data to a new canonical deployment.
 * *
 * @param state - offline committed singleton.
 * *
 * @param deployment - validated replacement origin, RP and mount.
 * *
 * @param clearPasskeys - explicit authorization required when RP changes.
 * *
 * @returns revoked replacement, retaining compatible passkeys.
 */
export function reconfigureAuth(state: Readonly<AuthState>, deployment: AuthDeployment, clearPasskeys: boolean): AuthState {
  const changedRP = deployment.rpId !== state.deployment.rpId
  if (changedRP && !clearPasskeys) throw new AuthError('auth/invalid-request', 'Changing rpId requires --clear-passkeys and new device enrollment.')
  return revokeAll({
    ...state, deployment, passkeys: clearPasskeys ? [] : state.passkeys,
    userHandle: changedRP ? randomBytes(32).toString('base64url') : state.userHandle,
  })
}
