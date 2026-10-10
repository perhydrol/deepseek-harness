/** Canonical request origin, direct-peer proxy trust and bounded JSON parsing. */
import { isIP } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import ipaddr from 'ipaddr.js'
import { AuthError } from '@hydrogen/dsh-browser-auth'
import type { BrowserRequest, BrowserTrustPolicy } from '@hydrogen/dsh-browser-auth'
import type { IncomingMessage } from 'node:http'

type Policy = Extract<BrowserTrustPolicy, { mode: 'single-user' }>
/**
 * Read a scalar request header and reject duplicate values.
 * @param request - transport-owned facts.
 * *
 * @param name - lower-case header name.
 * *
 * @returns one scalar header; duplicates are rejected.
 */
export function header(request: BrowserRequest, name: string): string | undefined {
  const value = request.headers instanceof Headers ? request.headers.get(name) ?? undefined : request.headers[name]
  if (Array.isArray(value)) throw new AuthError('auth/invalid-request', 'Duplicate authentication header.')
  return typeof value === 'string' ? value : undefined
}

/**
 * Validate the deployment authority and resolve a trusted client address.
 * @param request - transport facts.
 * @param policy - canonical deployment.
 * @returns normalized client IP from one trusted hop.
 */
export function resolveRequestClient(request: BrowserRequest, policy: Policy): string {
  const host = header(request, 'host')
  if (host !== new URL(policy.publicOrigin).host) throw new AuthError('auth/forbidden', 'Request authority is not allowed.')
  const peer = request.remoteAddress
  if (peer === undefined || isIP(peer) === 0) throw new AuthError('auth/forbidden', 'Request peer address is unavailable.')
  const address = normalize(peer)
  if (policy.upstream.kind === 'direct') return address.toString()
  const trusted = policy.upstream.trustedPeers.some((cidr) => {
    const [network, prefix] = ipaddr.parseCIDR(cidr)
    return address.kind() === network.kind() && address.match([network, prefix])
  })
  if (!trusted) throw new AuthError('auth/forbidden', 'Request peer is outside the trusted proxy network.')
  const client = header(request, policy.upstream.clientIpHeader)
  if (client === undefined || isIP(client) === 0) throw new AuthError('auth/forbidden', 'Trusted proxy must overwrite one canonical client IP header.')
  return normalize(client).toString()
}

/**
 * Require the canonical Origin, JSON media type and matching CSRF proof.
 * @param request - mutating request.
 * *
 * @param policy - canonical public origin.
 * *
 * @param proof - expected session or pre-auth CSRF token.
 */
export function assertMutationRequest(request: BrowserRequest, policy: Policy, proof: string): void {
  if (request.method !== 'POST' || header(request, 'origin') !== policy.publicOrigin
    || header(request, 'content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
    || !equalProof(header(request, 'x-dsh-csrf'), proof)) {
    throw new AuthError('auth/forbidden', 'Authentication mutation requires the public Origin, JSON and a valid CSRF proof.')
  }
}

/**
 * Compare authentication proofs without leaking equal-length contents.
 * @param candidate - untrusted proof.
 * *
 * @param expected - expected secret proof.
 * *
 * @returns constant-time equality after public length check.
 */
export function equalProof(candidate: string | undefined, expected: string): boolean {
  if (candidate === undefined) return false
  const a = Buffer.from(candidate)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Read one bounded JSON body with the configured byte limit.
 * @param request - Node HTTP body.
 * *
 * @param limit - maximum accepted UTF-8 bytes.
 * *
 * @returns decoded JSON for operation-specific validation.
 */
export async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const value of request) {
    const chunk: Buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value))
    size += chunk.length
    if (size > limit) throw new AuthError('auth/invalid-request', 'Authentication request is too large.')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch (error) { throw new AuthError('auth/invalid-request', 'Authentication request must contain valid JSON.', { cause: error }) }
}

/**
 * Extract browser request facts from the HTTP carrier.
 * @param request - Node request.
 * @returns trusted transport adapter facts.
 */
export function browserRequest(request: IncomingMessage): BrowserRequest {
  return { headers: request.headers, method: request.method ?? 'GET', url: request.url ?? '/', remoteAddress: request.socket.remoteAddress }
}
function normalize(value: string): ipaddr.IPv4 | ipaddr.IPv6 {
  const address = ipaddr.parse(value)
  return address instanceof ipaddr.IPv6 && address.isIPv4MappedAddress() ? address.toIPv4Address() : address
}
