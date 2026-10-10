/** Pure state transitions for single-operator authentication. */
import { randomBytes } from 'node:crypto'
import type { AuthDeployment, AuthState, PasswordRecord } from '@hydrogen/dsh-browser-auth/types'

/**
 * Construct the singleton state for an exclusively owned, uninitialized store.
 * *
 * @param deployment - validated canonical public deployment.
 * *
 * @param password - independently hashed password.
 * *
 * @returns initial state; the store assigns the committed revision.
 */
export function initializeAuthState(deployment: AuthDeployment, password: PasswordRecord): AuthState {
  return { schemaVersion: 1, revision: 0, deployment, password, userHandle: randomBytes(32).toString('base64url'), csrfSecret: randomBytes(32).toString('base64url'), generation: 1, passkeys: [], sessions: [] }
}

/**
 * Revoke every session and invalidate outstanding proofs in one state update.
 * *
 * @param state - current committed singleton.
 * *
 * @returns replacement with a new generation and CSRF secret.
 */
export function revokeAll(state: Readonly<AuthState>): AuthState {
  return { ...state, generation: state.generation + 1, csrfSecret: randomBytes(32).toString('base64url'), sessions: [] }
}
