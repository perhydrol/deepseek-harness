/** Admission deadlines remain authoritative when timer delivery is delayed. */
import { describe, expect, it } from 'vitest'
import { isAdmissionLive } from '../src/lifetime.ts'

describe('admission lifetime', () => {
  it('refuses the exact deadline and a revoked session', () => {
    const controller = new AbortController()
    const lifetime = { expiresAt: 100, revoked: controller.signal }
    expect(isAdmissionLive(lifetime, 99)).toBe(true)
    expect(isAdmissionLive(lifetime, 100)).toBe(false)
    controller.abort()
    expect(isAdmissionLive(lifetime, 99)).toBe(false)
  })
})
