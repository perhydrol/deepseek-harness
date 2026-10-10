/** Proxy identity and canonical public-origin checks reject caller-controlled forwarding. */
import { expect, it } from 'vitest'
import { resolveRequestClient, assertMutationRequest } from '../src/request.ts'
import type { BrowserRequest, BrowserTrustPolicy } from '@hydrogen/dsh-browser-auth'

const policy: Extract<BrowserTrustPolicy, { mode: 'single-user' }> = {
  mode: 'single-user', publicOrigin: 'https://harness.example', mountPath: '/',
  upstream: { kind: 'proxy', trustedPeers: ['10.0.0.0/24'], clientIpHeader: 'x-real-ip' },
}
const request = (remoteAddress: string, extra: Record<string, string> = {}): BrowserRequest => ({
  method: 'POST', url: '/auth/password/login', remoteAddress,
  headers: { host: 'harness.example', origin: 'https://harness.example', 'content-type': 'application/json', ...extra },
})
it('accepts one overwritten IP only from an explicitly trusted direct peer', () => {
  expect(resolveRequestClient(request('10.0.0.4', { 'x-real-ip': '2001:db8::1' }), policy)).toBe('2001:db8::1')
  expect(() => resolveRequestClient(request('192.0.2.4', { 'x-real-ip': '127.0.0.1' }), policy)).toThrow()
  expect(() => resolveRequestClient(request('10.0.0.4', { 'x-real-ip': '192.0.2.1, 127.0.0.1' }), policy)).toThrow()
})
it('requires exact Origin, JSON and a matching custom CSRF header', () => {
  expect(() =>{  assertMutationRequest(request('10.0.0.4', { 'x-dsh-csrf': 'proof' }), policy, 'proof') }).not.toThrow()
  expect(() =>{  assertMutationRequest(request('10.0.0.4', { origin: 'http://harness.example', 'x-dsh-csrf': 'proof' }), policy, 'proof') }).toThrow()
  expect(() =>{  assertMutationRequest(request('10.0.0.4', { 'content-type': 'text/plain', 'x-dsh-csrf': 'proof' }), policy, 'proof') }).toThrow()
  expect(() =>{  assertMutationRequest(request('10.0.0.4', { 'x-dsh-csrf': 'wrong' }), policy, 'proof') }).toThrow()
})
