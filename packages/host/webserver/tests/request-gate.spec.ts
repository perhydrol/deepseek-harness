/** Revocable admissions stop active carriers and release their timers. */
import { afterEach, expect, it, vi } from 'vitest'
import { bindWebAdmission } from '../src/request-gate.ts'

afterEach(() => { vi.useRealTimers() })

it('closes an active carrier on revocation and cancels its deadline', () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const close = vi.fn()
  const dispose = bindWebAdmission({ expiresAt: Date.now() + 60_000, revoked: controller.signal }, close)
  controller.abort()
  expect(close).toHaveBeenCalledTimes(1)
  vi.advanceTimersByTime(60_000)
  expect(close).toHaveBeenCalledTimes(1)
  dispose()
})

it('waits for a long absolute deadline without timer overflow', () => {
  vi.useFakeTimers()
  const lifetime = 30 * 24 * 60 * 60 * 1000
  const close = vi.fn()
  bindWebAdmission({ expiresAt: Date.now() + lifetime, revoked: new AbortController().signal }, close)
  vi.advanceTimersByTime(lifetime - 1)
  expect(close).not.toHaveBeenCalled()
  vi.advanceTimersByTime(1)
  expect(close).toHaveBeenCalledTimes(1)
})

it('keeps a completed carrier detached from subsequent revocation', () => {
  vi.useFakeTimers()
  const controller = new AbortController()
  const close = vi.fn()
  const dispose = bindWebAdmission({ expiresAt: Date.now() + 60_000, revoked: controller.signal }, close)
  dispose()
  controller.abort()
  vi.advanceTimersByTime(60_000)
  expect(close).not.toHaveBeenCalled()
})

it('closes an admission that expired before transport binding', () => {
  const close = vi.fn()
  const dispose = bindWebAdmission({ expiresAt: Date.now(), revoked: new AbortController().signal }, close)
  expect(close).toHaveBeenCalledTimes(1)
  dispose()
})
