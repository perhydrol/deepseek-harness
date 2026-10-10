// @vitest-environment jsdom
/** BFcache restoration must survive disposal of the private application tree. */
import { expect, it, vi } from 'vitest'
import { discardPrivatePage } from '../src/client/page-lifecycle.ts'

it('reloads a restored document after private application disposal', () => {
  const reload = vi.fn()
  const discard = vi.fn()
  discardPrivatePage({ persisted: true }, window, discard, reload)
  expect(discard).toHaveBeenCalledTimes(1)
  expect(reload).not.toHaveBeenCalled()
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }))
  expect(reload).toHaveBeenCalledTimes(1)
})

it('discards a normally departing document without leaving a restore listener', () => {
  const reload = vi.fn()
  const discard = vi.fn()
  discardPrivatePage({ persisted: false }, window, discard, reload)
  expect(discard).toHaveBeenCalledTimes(1)
  window.dispatchEvent(new PageTransitionEvent('pageshow'))
  expect(reload).not.toHaveBeenCalled()
})
