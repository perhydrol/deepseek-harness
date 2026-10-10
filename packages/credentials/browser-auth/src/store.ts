/** Versioned authentication state validation and synchronous store obligations. */
import { z } from 'zod'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { AuthState, BrowserSessionId, PasskeyId } from './types.ts'
import { AuthError } from './errors.ts'

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const encoded = (minimum: number, maximum = minimum) => z.string().min(minimum).max(maximum)
  .refine(value => /^[A-Za-z0-9_-]+$/.test(value) && Buffer.from(value, 'base64url').toString('base64url') === value)
const password = z.strictObject({
  algorithm: z.literal('scrypt'), N: integer.min(131072).max(1048576), r: integer.min(8).max(32),
  p: integer.min(1).max(4), maxmem: integer.min(1).max(512 * 1024 * 1024),
  salt: encoded(43), hash: encoded(86),
}).refine(value => (value.N & (value.N - 1)) === 0 && value.maxmem > 128 * value.N * value.r + 1024 * 1024)
const deployment = z.strictObject({
  publicOrigin: z.string().max(2048), rpId: z.string().min(1).max(253),
  mountPath: z.string().min(1).max(1024),
}).refine((value) => {
  try {
    const origin = new URL(value.publicOrigin)
    return origin.origin === value.publicOrigin
      && (origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))
      && origin.hostname === value.rpId && value.mountPath.startsWith('/') && value.mountPath.endsWith('/')
      && new URL(value.mountPath, origin).pathname === value.mountPath
      && !value.mountPath.includes('//') && !/[?#%\\]/.test(value.mountPath)
  } catch { return false }
})
const schema: z.ZodType<AuthState> = z.strictObject({
  schemaVersion: z.literal(1), revision: integer, deployment, password,
  userHandle: encoded(43), csrfSecret: encoded(43), generation: integer.min(1),
  passkeys: z.array(z.strictObject({
    id: encoded(1, 2048).transform(value => brandString<PasskeyId>(value)),
    publicKey: encoded(1, 16384), counter: integer, revision: integer.min(1),
    transports: z.array(z.enum(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb'])).max(7),
    deviceType: z.enum(['singleDevice', 'multiDevice']), backedUp: z.boolean(),
    label: z.string().max(512).refine(value => Buffer.byteLength(value, 'utf8') <= 512),
    createdAt: integer, lastUsedAt: integer.nullable(),
  })).max(128),
  sessions: z.array(z.strictObject({
    id: encoded(43).transform(value => brandString<BrowserSessionId>(value)),
    createdAt: integer, expiresAt: integer, generation: integer.min(1),
  }).refine(value => value.expiresAt > value.createdAt)).max(1024),
}).refine(value => new Set(value.sessions.map(session => session.id)).size === value.sessions.length
  && value.sessions.every(session => session.generation === value.generation)
  && new Set(value.passkeys.map(key => key.id)).size === value.passkeys.length)

/**
 * Parse untrusted durable JSON without exposing stored fields in diagnostics.
 * *
 * @param value - JSON decoded from the authentication database.
 * *
 * @returns validated singleton state.
 * *
 * @throws AuthError when fields, costs, generations or identities are invalid.
 */
export function parseAuthState(value: unknown): AuthState {
  const result = schema.safeParse(value)
  if (!result.success) throw new AuthError('auth/storage', 'Authentication data is invalid or unsupported; stop the Host and recover a verified backup.')
  return result.data
}

/** Synchronous committed snapshots; failure invalidates the whole instance. */
export interface AuthStore<T> {
  readonly unavailable: AbortSignal
  /**
 * @returns deeply frozen committed singleton, or absence in initialization mode.
 */
  read(): Readonly<T> | undefined
  /**
 * @param transform - synchronous immutable state transformation.
 * @returns committed deeply frozen state.
 */
  update(transform: (current: Readonly<T> | undefined) => T): Readonly<T>
  /**
 * @param listener - synchronous observer called after commit.
 * @returns disposer.
 */
  subscribe(listener: (committed: Readonly<T>) => void): () => void
}
