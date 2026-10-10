/** Real SQLite commits must precede cache publication and admission invalidation. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { openAuthStore } from '../src/database.ts'
import { initializeAuthState } from '../../browser-auth-single-user/src/state.ts'
import { hashPassword } from '../../browser-auth-single-user/src/password.ts'
import { resolvePasswordPolicy } from '../../browser-auth-single-user/src/config.ts'

describe.runIf(process.platform === 'linux')('persistent authentication store', () => {
  it('commits WAL/FULL state before notifying and preserves it on restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-auth-'))
    try {
      const path = join(root, 'private', 'auth.sqlite')
      const store = await openAuthStore({ path, mode: 'initialize' })
      const password = await hashPassword('private test password', resolvePasswordPolicy({}))
      const initial = initializeAuthState({ publicOrigin: 'https://harness.example', rpId: 'harness.example', mountPath: '/' }, password)
      const observed: number[] = []
      store.subscribe((state) => { expect(store.read()).toBe(state); observed.push(state.revision) })
      const committed = store.update(() => initial)
      expect(store.diagnostics()).toEqual({ synchronous: 2, journalMode: 'wal' })
      expect(observed).toEqual([1])
      expect(Object.isFrozen(committed.sessions)).toBe(true)
      expect(() => store.update(() => { throw new Error('transform failed') })).toThrow('transform failed')
      expect(store.read()).toBe(committed)
      await expect(openAuthStore({ path, mode: 'open' })).rejects.toMatchObject({ code: 'auth/ownership' })
      await store.close()
      const reopened = await openAuthStore({ path, mode: 'open' })
      try { expect(reopened.read()).toEqual(committed) } finally { await reopened.close() }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
  it('invalidates the store if a committed state cannot be published', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-auth-observer-'))
    try {
      const store = await openAuthStore({ path: join(root, 'private', 'auth.sqlite'), mode: 'initialize' })
      try {
        const password = await hashPassword('private test password', resolvePasswordPolicy({}))
        const initial = initializeAuthState({ publicOrigin: 'https://harness.example', rpId: 'harness.example', mountPath: '/' }, password)
        store.subscribe(() => { throw new Error('observer failed') })
        expect(() => store.update(() => initial)).toThrow()
        expect(store.unavailable.aborted).toBe(true)
        expect(() => store.read()).toThrow()
      } finally { await store.close() }
    } finally { await rm(root, { recursive: true, force: true }) }
  })
})
