/** Persistent bearer sessions expire and revoke independently of the operator Peer. */
import { expect, it } from 'vitest'
import { SessionAdmissions } from '../src/sessions.ts'
import { initializeAuthState } from '../src/state.ts'
import { hashPassword } from '../src/password.ts'
import { resolvePasswordPolicy } from '../src/config.ts'
import type { AuthState, AuthStore } from '@hydrogen/dsh-browser-auth'

it('shares a persistent session across tabs, revokes one session and checks exact deadlines', async () => {
  let current = initializeAuthState({ publicOrigin: 'https://harness.example', rpId: 'harness.example', mountPath: '/' },
    await hashPassword('private test password', resolvePasswordPolicy({})))
  const listeners = new Set<(state: Readonly<AuthState>) => void>()
  const failure = new AbortController()
  const store: AuthStore<AuthState> = {
    unavailable: failure.signal,
    read: () => current,
    update: (transform) => {
      current = transform(current)
      for (const listener of listeners) listener(current)
      return current
    },
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
  const sessions = new SessionAdmissions(store, { lifetimeMs: 1000, limit: 2 })
  const now = Date.now()
  const first = sessions.create(now)
  const second = sessions.create(now)
  expect(sessions.authenticate(first.token, now + 999)).toBe(first.lifetime)
  expect(sessions.csrf(first.lifetime.sessionId)).toBe(sessions.csrf(first.lifetime.sessionId))
  sessions.logout(first.lifetime.sessionId)
  expect(first.lifetime.revoked.aborted).toBe(true)
  expect(second.lifetime.revoked.aborted).toBe(false)
  expect(sessions.authenticate(second.token, now + 1000)).toBeUndefined()
  sessions.close()
})
