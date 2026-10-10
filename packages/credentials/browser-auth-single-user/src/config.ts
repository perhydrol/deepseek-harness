/** Validated password hashing policy and resource budgets. */
import ipaddr from 'ipaddr.js'
import type { BrowserTrustPolicy } from '@hydrogen/dsh-browser-auth'
import { AuthError } from '@hydrogen/dsh-browser-auth'

/** Resolved instance-owned password hashing configuration. */
export interface PasswordPolicy {
  /** Minimum password length in UTF-8 bytes. */
  readonly minimumBytes: number
  /** Maximum password length in UTF-8 bytes. */
  readonly maximumBytes: number
  /** scrypt CPU and memory cost; a supported power of two. */
  readonly N: number
  /** scrypt block size parameter. */
  readonly r: number
  /** scrypt parallelization parameter. */
  readonly p: number
  /** Maximum bytes available to one scrypt operation. */
  readonly maxmem: number
  /** Maximum simultaneous password hashing operations. */
  readonly activeLimit: number
  /** Maximum queued password hashing operations. */
  readonly queueLimit: number
}

/**
 * Resolve policy once before accepting password work.
 * *
 * @param input - deployment settings; omitted values use bounded defaults.
 * *
 * @returns validated hashing and queue budgets.
 * *
 * @throws AuthError when security minimums or allocation limits are violated.
 */
export function resolvePasswordPolicy(input: Partial<PasswordPolicy>): PasswordPolicy {
  const policy = {
    minimumBytes: 12, maximumBytes: 1024, N: 131072, r: 8, p: 1,
    maxmem: 192 * 1024 * 1024, activeLimit: 1, queueLimit: 4, ...input,
  }
  if (!Object.values(policy).every(Number.isSafeInteger)
    || policy.minimumBytes < 12 || policy.maximumBytes < policy.minimumBytes || policy.maximumBytes > 4096
    || policy.N < 131072 || policy.N > 1048576 || (policy.N & (policy.N - 1)) !== 0
    || policy.r < 8 || policy.r > 32 || policy.p < 1 || policy.p > 4
    || policy.maxmem > 512 * 1024 * 1024 || policy.maxmem <= 128 * policy.N * policy.r + 1024 * 1024
    || policy.activeLimit < 1 || policy.activeLimit > 4 || policy.queueLimit < 0 || policy.queueLimit > 32) {
    throw new AuthError('auth/password-policy', 'Invalid password cost or resource budget; use the documented scrypt minimum and memory bounds.')
  }
  return Object.freeze(policy)
}

/** Single-operator deployment configuration; defaults resolve once at activation. */
export interface SingleUserConfig {
  /** Canonical browser-facing HTTPS origin without a trailing path. */
  publicOrigin: string
  /** WebAuthn relying-party identifier matching the public origin hostname. */
  rpId: string
  /** Canonical external application directory path, including its trailing slash. */
  mountPath?: string
  /** Allow explicit loopback HTTP development. */
  development?: boolean
  /** Direct listener or explicitly trusted proxy peers and overwritten client-IP header. */
  upstream?: {
    /** Admit requests directly from the listener peer. */
    kind: 'direct'
  } | {
    /** Admit requests through explicitly trusted proxies. */
    kind: 'proxy'
    /** CIDRs of direct proxy peers permitted to supply the client-IP header. */
    trustedPeers: string[]
    /** Dedicated scalar client-IP header overwritten by the trusted proxy. */
    clientIpHeader: string
  }
  /** Password hashing costs, byte limits and work queue budgets. */
  password?: Partial<PasswordPolicy>
  /** Absolute browser session lifetime in milliseconds. */
  sessionLifetimeMs?: number
  /** Maximum live persistent browser sessions. */
  sessionLimit?: number
  /** Maximum operator passkey credentials. */
  passkeyLimit?: number
  /** Passkey challenge lifetime in milliseconds. */
  challengeLifetimeMs?: number
  /** Maximum live challenges and management grants. */
  challengeLimit?: number
  /** Anonymous login proof lifetime in milliseconds. */
  preauthLifetimeMs?: number
  /** Maximum live anonymous login proofs. */
  preauthLimit?: number
  /** Sensitive-operation reauthentication grant lifetime in milliseconds. */
  reauthLifetimeMs?: number
  /** Maximum bytes accepted in an authentication JSON body. */
  bodyLimitBytes?: number
  /** Maximum passkey label length in UTF-8 bytes. */
  labelLimitBytes?: number
  /** Authentication rate-limit window in milliseconds. */
  attemptWindowMs?: number
  /** Maximum login attempts per trusted client in one window. */
  attemptsPerClient?: number
  /** Maximum login attempts across clients in one window. */
  attemptsGlobal?: number
  /** Maximum clients retained in the rate limiter. */
  limiterClients?: number
  /** Maximum management attempts per session in one window. */
  managementAttempts?: number
}

/** Fully resolved deployment budgets. */
export interface ResolvedSingleUserConfig {
  readonly trustPolicy: Extract<BrowserTrustPolicy, { mode: 'single-user' }>
  /** Password hashing costs, byte limits and work queue budgets. */
  readonly password: PasswordPolicy
  /** Absolute browser session lifetime in milliseconds. */
  readonly sessionLifetimeMs: number
  /** Maximum live persistent browser sessions. */
  readonly sessionLimit: number
  /** Maximum operator passkey credentials. */
  readonly passkeyLimit: number
  /** Passkey challenge lifetime in milliseconds. */
  readonly challengeLifetimeMs: number
  /** Maximum live challenges and management grants. */
  readonly challengeLimit: number
  /** Anonymous login proof lifetime in milliseconds. */
  readonly preauthLifetimeMs: number
  /** Maximum live anonymous login proofs. */
  readonly preauthLimit: number
  /** Sensitive-operation reauthentication grant lifetime in milliseconds. */
  readonly reauthLifetimeMs: number
  /** Maximum bytes accepted in an authentication JSON body. */
  readonly bodyLimitBytes: number
  /** Maximum passkey label length in UTF-8 bytes. */
  readonly labelLimitBytes: number
  /** Authentication rate-limit window in milliseconds. */
  readonly attemptWindowMs: number
  /** Maximum login attempts per trusted client in one window. */
  readonly attemptsPerClient: number
  /** Maximum login attempts across clients in one window. */
  readonly attemptsGlobal: number
  /** Maximum clients retained in the rate limiter. */
  readonly limiterClients: number
  /** Maximum management attempts per session in one window. */
  readonly managementAttempts: number
}

/**
 * Resolve canonical origin, explicit proxy trust and bounded resource budgets.
 * *
 * @param input - validated plugin configuration.
 * *
 * @returns immutable instance configuration.
 */
export function resolveSingleUserConfig(input: SingleUserConfig): ResolvedSingleUserConfig {
  const origin = new URL(input.publicOrigin)
  const development = input.development === true
  if (origin.origin !== input.publicOrigin || origin.hostname !== input.rpId
    || (origin.protocol !== 'https:' && !(development && origin.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)))) {
    throw new AuthError('auth/invalid-request', 'Configure a canonical HTTPS publicOrigin and matching rpId; HTTP requires explicit loopback development.')
  }
  const mountPath = input.mountPath ?? '/'
  if (!mountPath.startsWith('/') || !mountPath.endsWith('/') || /[?#%\\]/.test(mountPath)
    || mountPath.includes('//') || new URL(mountPath, origin).pathname !== mountPath) {
    throw new AuthError('auth/invalid-request', 'Authentication mountPath must be a canonical absolute directory path.')
  }
  const upstream = input.upstream ?? { kind: 'direct' }
  if (upstream.kind === 'proxy') {
    if (upstream.trustedPeers.length === 0 || upstream.trustedPeers.length > 64
      || !/^x-[a-z0-9-]+$/.test(upstream.clientIpHeader)
      || ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto'].includes(upstream.clientIpHeader)) {
      throw new AuthError('auth/invalid-request', 'Configure explicit trusted proxy CIDRs and one overwritten client IP header.')
    }
    for (const peer of upstream.trustedPeers) {
      try {
        const [address, prefix] = ipaddr.parseCIDR(peer)
        if (prefix === 0 || (address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress())) throw new Error('ambiguous CIDR')
      } catch (error) {
        throw new AuthError('auth/invalid-request', 'Trusted proxy CIDRs must be valid explicit IPv4 or IPv6 networks.', { cause: error })
      }
    }
  }
  const resolved: ResolvedSingleUserConfig = {
    trustPolicy: { mode: 'single-user', publicOrigin: origin.origin, mountPath, upstream },
    password: resolvePasswordPolicy(input.password ?? {}),
    sessionLifetimeMs: input.sessionLifetimeMs ?? 30 * 86400000,
    sessionLimit: input.sessionLimit ?? 32, passkeyLimit: input.passkeyLimit ?? 16,
    challengeLifetimeMs: input.challengeLifetimeMs ?? 300000, challengeLimit: input.challengeLimit ?? 64,
    preauthLifetimeMs: input.preauthLifetimeMs ?? 600000, preauthLimit: input.preauthLimit ?? 128,
    reauthLifetimeMs: input.reauthLifetimeMs ?? 300000, bodyLimitBytes: input.bodyLimitBytes ?? 65536,
    labelLimitBytes: input.labelLimitBytes ?? 128, attemptWindowMs: input.attemptWindowMs ?? 60000,
    attemptsPerClient: input.attemptsPerClient ?? 8, attemptsGlobal: input.attemptsGlobal ?? 32,
    limiterClients: input.limiterClients ?? 4096, managementAttempts: input.managementAttempts ?? 8,
  }
  for (const [name, value] of Object.entries(resolved)) {
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || value < 1 || value > Number.MAX_SAFE_INTEGER / 2)) {
      throw new AuthError('auth/invalid-request', `Authentication budget ${name} must be a positive safe integer.`)
    }
  }
  if (resolved.sessionLimit > 1024 || resolved.passkeyLimit > 128 || resolved.labelLimitBytes > 512
    || resolved.bodyLimitBytes > 1048576 || resolved.challengeLimit > 4096 || resolved.preauthLimit > 4096
    || resolved.limiterClients > 65536 || resolved.sessionLifetimeMs > 365 * 86400000) {
    throw new AuthError('auth/invalid-request', 'Authentication resource budgets exceed supported limits.')
  }
  return Object.freeze(resolved)
}
