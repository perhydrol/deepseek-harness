/** Session loss clears private state; a network outage preserves recoverable application state. */
import { expect, it, vi } from 'vitest'
import { SessionGuard } from '../src/client/session-guard.ts'

it('preserves the application on network loss and ends it only on confirmed unauthenticated state', async () => {
  const fetcher = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('offline'))
    .mockResolvedValueOnce(Response.json({ authenticated: false, csrf: 'proof', password: true, passkey: false }))
  const ended = vi.fn(async () => {})
  const guard = new SessionGuard('/', ended, fetcher)
  try {
    await guard.check()
    expect(ended).not.toHaveBeenCalled()
    await guard.check()
    expect(ended).toHaveBeenCalledTimes(1)
    await guard.check()
    expect(ended).toHaveBeenCalledTimes(1)
  } finally { guard.stop() }
})

it('deduplicates concurrent checks and ignores a late response after disposal', async () => {
  const response = Promise.withResolvers<Response>()
  const fetcher = vi.fn<typeof fetch>().mockReturnValue(response.promise)
  const ended = vi.fn(async () => {})
  const guard = new SessionGuard('/', ended, fetcher)
  const checking = guard.check()
  await guard.check()
  expect(fetcher).toHaveBeenCalledTimes(1)
  guard.stop()
  response.resolve(Response.json({ authenticated: false, csrf: 'proof', password: true, passkey: false }))
  await checking
  expect(ended).not.toHaveBeenCalled()
})
