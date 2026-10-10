/** Password bytes, persisted costs and work admission are security decisions. */
import { describe, expect, it } from 'vitest'
import { hashPassword, verifyPassword, PasswordHasher } from '../src/password.ts'
import { resolvePasswordPolicy } from '../src/config.ts'

describe('password hashing', () => {
  it('preserves whitespace and uses independent random salts', async () => {
    const policy = resolvePasswordPolicy({})
    const input = '  private password  '
    const first = await hashPassword(input, policy)
    const second = await hashPassword(input, policy)
    expect(first.salt).not.toBe(second.salt)
    expect(await verifyPassword(input, first, policy)).toBe(true)
    expect(await verifyPassword(input.trim(), first, policy)).toBe(false)
  })
  it('measures UTF-8 bytes without normalizing Unicode', async () => {
    const policy = resolvePasswordPolicy({ minimumBytes: 12, maximumBytes: 20 })
    await expect(hashPassword('短', policy)).rejects.toMatchObject({ code: 'auth/password-policy' })
    await expect(hashPassword('密'.repeat(7), policy)).rejects.toMatchObject({ code: 'auth/password-policy' })
    const first = await hashPassword('é'.repeat(6), policy)
    expect(await verifyPassword('é'.repeat(6), first, policy)).toBe(false)
  })
  it('refuses excessive persisted costs before allocating KDF memory', async () => {
    const policy = resolvePasswordPolicy({})
    const record = await hashPassword('test password twelve', policy)
    await expect(verifyPassword('test password twelve', { ...record, N: 2 ** 30 }, policy))
      .rejects.toMatchObject({ code: 'auth/password-record' })
    await expect(verifyPassword('test password twelve', { ...record, hash: '%' }, policy))
      .rejects.toMatchObject({ code: 'auth/password-record' })
  })
  it('bounds active work and its waiting queue, and drains before disposal', async () => {
    const hasher = new PasswordHasher(resolvePasswordPolicy({ activeLimit: 1, queueLimit: 1 }))
    const first = hasher.hash('first private password')
    const second = hasher.hash('second private password')
    await expect(hasher.hash('third private password')).rejects.toMatchObject({ code: 'auth/busy' })
    const closing = hasher.close()
    await expect(second).rejects.toMatchObject({ code: 'auth/unavailable' })
    await first
    await closing
    await expect(hasher.hash('next private password')).rejects.toMatchObject({ code: 'auth/unavailable' })
  })
  it.each([{ N: 65536 }, { N: 131073 }, { maxmem: 1024 }, { activeLimit: 0 }, { minimumBytes: 1 }])(
    'rejects an unsafe policy %j', (config) => {
      expect(() => resolvePasswordPolicy(config)).toThrow()
    },
  )
})
