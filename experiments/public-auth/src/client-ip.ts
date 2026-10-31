/** Resolve a single Nginx-supplied client IP without trusting forwarded hosts or protocols. */
import { isIP } from 'node:net'

/** Compare equivalent IPv6 spellings and IPv4-mapped socket addresses. */
function normalize(ip: string): string {
  const value = ip.toLowerCase()
  if (isIP(value) !== 6 || value.includes('%')) return value
  const canonical = new URL(`http://[${value}]/`).hostname.slice(1, -1)
  const mapped = /^::ffff:([\da-f]+):([\da-f]+)$/.exec(canonical)
  if (!mapped) return canonical
  const high = parseInt(mapped[1]!, 16)
  const low = parseInt(mapped[2]!, 16)
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
}

/** Build a resolver with an explicit allowlist of immediate proxy peers.
 * @param configured Comma-separated literal proxy IPs; empty trusts no proxy.
 * @returns Resolver that rejects missing, invalid, or chained headers from trusted peers with HTTP 400.
 */
export function createClientIpResolver(configured = '') {
  const ips = configured === '' ? [] : configured.split(',').map(ip => ip.trim())
  if (ips.some(ip => !isIP(ip) || ip.includes('%'))) throw new Error('TRUSTED_PROXY_IPS must contain comma-separated literal IP addresses without zone identifiers')
  const trusted = new Set(ips.map(normalize))
  return (peer: string, forwarded: string | string[] | undefined): string => {
    if (!trusted.has(normalize(peer))) return peer
    const ip = typeof forwarded === 'string' ? forwarded.trim() : undefined
    if (!ip || !isIP(ip) || ip.includes('%')) throw Object.assign(new Error('Trusted proxy must supply one valid X-Forwarded-For IP without a zone identifier'), { statusCode: 400 })
    return normalize(ip)
  }
}
