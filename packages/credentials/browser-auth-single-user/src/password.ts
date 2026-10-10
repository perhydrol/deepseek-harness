/** Asynchronous salted scrypt and instance-owned bounded work admission. */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { AuthError } from '@hydrogen/dsh-browser-auth'
import type { PasswordRecord } from '@hydrogen/dsh-browser-auth/types'
import type { PasswordPolicy } from './config.ts'

function passwordBytes(password: string, policy: PasswordPolicy): Buffer {
  const bytes = Buffer.from(password, 'utf8')
  if (bytes.length < policy.minimumBytes || bytes.length > policy.maximumBytes) {
    throw new AuthError('auth/password-policy', 'Password UTF-8 length is outside the configured limits.')
  }
  return bytes
}
function decode(value: string, length: number): Buffer | undefined {
  const bytes = Buffer.from(value, 'base64url')
  return bytes.length === length && bytes.toString('base64url') === value ? bytes : undefined
}
function derive(password: Buffer, salt: Buffer, cost: Pick<PasswordPolicy, 'N' | 'r' | 'p' | 'maxmem'>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, cost, (error, key) => {
      if (error !== null) reject(new AuthError('auth/unavailable', 'Password hashing failed; check the configured resource budget.', { cause: error }))
      else resolve(key)
    })
  })
}

/**
 * Hash the exact UTF-8 password bytes with a fresh random salt.
 * *
 * @param password - untrimmed password.
 * *
 * @param policy - validated instance policy.
 * *
 * @returns persistable algorithm, parameters, salt and hash.
 */
export async function hashPassword(password: string, policy: PasswordPolicy): Promise<PasswordRecord> {
  const input = passwordBytes(password, policy)
  const salt = randomBytes(32)
  const hash = await derive(input, salt, policy)
  return { algorithm: 'scrypt', N: policy.N, r: policy.r, p: policy.p, maxmem: policy.maxmem, salt: salt.toString('base64url'), hash: hash.toString('base64url') }
}

/**
 * Validate persisted costs before allocating memory, then compare in constant time.
 * *
 * @param password - exact candidate bytes.
 * *
 * @param record - parsed persisted password record.
 * *
 * @param policy - maximum accepted costs and input length.
 * *
 * @returns whether the candidate matches.
 * *
 * @throws AuthError for invalid records or unavailable hashing resources.
 */
export async function verifyPassword(password: string, record: PasswordRecord, policy: PasswordPolicy): Promise<boolean> {
  const { N, r, p, maxmem } = record
  const salt = decode(record.salt, 32)
  const expected = decode(record.hash, 64)
  if (![N, r, p, maxmem].every(Number.isSafeInteger)
    || N < 131072 || N > policy.N || (N & (N - 1)) !== 0
    || r < 8 || r > policy.r || p < 1 || p > policy.p
    || maxmem > policy.maxmem || maxmem <= 128 * N * r + 1024 * 1024
    || salt === undefined || expected === undefined) {
    throw new AuthError('auth/password-record', 'Stored password parameters exceed the configured supported costs; stop the Host and recover locally.')
  }
  const input = passwordBytes(password, policy)
  return timingSafeEqual(await derive(input, salt, record), expected)
}

interface WaitingWork { readonly enter: () => void; readonly reject: (error: AuthError) => void }

/** Bounds work per provider and drains admitted work before releasing its owner. */
export class PasswordHasher {
  private active = 0
  private stopped = false
  private readonly waiting: WaitingWork[] = []
  private readonly drained = Promise.withResolvers<void>()
  /**
 * @param policy - validated hashing and queue budgets owned by this instance.
 */
  constructor(private readonly policy: PasswordPolicy) {}

  /**
   * Hash a password through the bounded instance queue.
   * @param password - exact candidate password.
   * @returns new salted password record after work admission.
 */
  hash(password: string): Promise<PasswordRecord> { return this.run(() => hashPassword(password, this.policy)) }

  /**
   * Verify a password through the bounded instance queue.
 * @param password - exact candidate password.
 * @param record - persisted password.
 * @returns comparison after work admission.
 */
  verify(password: string, record: PasswordRecord): Promise<boolean> {
    return this.run(() => verifyPassword(password, record, this.policy))
  }

  /** Refuse new/queued work and wait for active scrypt calls to release resources. */
  async close(): Promise<void> {
    this.stopped = true
    for (const waiting of this.waiting.splice(0)) waiting.reject(new AuthError('auth/unavailable', 'Authentication is stopping.'))
    if (this.active === 0) this.drained.resolve()
    await this.drained.promise
  }

  private finishDrain(): void { if (this.stopped && this.active === 0) this.drained.resolve() }

  private async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopped) throw new AuthError('auth/unavailable', 'Authentication is stopping.')
    if (this.active >= this.policy.activeLimit) {
      if (this.waiting.length >= this.policy.queueLimit) throw new AuthError('auth/busy', 'Password verification is busy; try again later.')
      await new Promise<void>((enter, reject) => { this.waiting.push({ enter, reject }) })
    } else this.active += 1
    try { return await operation() }
    finally {
      const next = this.waiting.shift()
      if (next === undefined) this.active -= 1
      else next.enter()
      this.finishDrain()
    }
  }
}
