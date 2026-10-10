/** One-use proofs are consumed before verification and cannot cross operation or session contexts. */
import { expect, it } from 'vitest'
import { OneUseProofs } from '../src/challenges.ts'
const context = { purpose: 'login', binding: 'preauth-one', generation: 1 } as const
it('consumes before returning and rejects replay and exact expiry', () => {
  const proofs = new OneUseProofs<string>(2, 100)
  const id = proofs.create(context, 'challenge', 10)
  expect(proofs.consume(id, context, 109)).toBe('challenge')
  expect(() => proofs.consume(id, context, 109)).toThrow()
  const expired = proofs.create(context, 'challenge', 10)
  expect(() => proofs.consume(expired, context, 110)).toThrow()
})
it('rejects cross-session and cross-purpose reuse, and bounds live proofs', () => {
  const proofs = new OneUseProofs<string>(1, 100)
  const id = proofs.create(context, 'challenge', 10)
  expect(() => proofs.create(context, 'another', 10)).toThrow()
  expect(() => proofs.consume(id, { ...context, purpose: 'reauth' }, 10)).toThrow()
  expect(() => proofs.consume(id, context, 10)).toThrow()
  const next = proofs.create(context, 'challenge', 10)
  expect(() => proofs.consume(next, { ...context, binding: 'other' }, 10)).toThrow()
})
