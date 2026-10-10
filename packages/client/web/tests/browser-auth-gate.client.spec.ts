/** Single-user boot admission precedes every business-module prefetch. */
import { expect, it, vi } from 'vitest'
import { checkBrowserAuthBeforeBoot } from '../src/browser-auth-gate.ts'

it('preserves default startup without performing an authentication request', async () => {
  const fetcher = vi.fn<typeof fetch>()
  expect(await checkBrowserAuthBeforeBoot(undefined, fetcher, vi.fn(), vi.fn())).toBe(true)
  expect(fetcher).not.toHaveBeenCalled()
})

it('clears the old page before navigating when the session is absent', async () => {
  const events: string[] = []
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ authenticated: false }))
  const admitted = await checkBrowserAuthBeforeBoot({ mountPath: '/private/' }, fetcher,
    (path) => { events.push(path) }, async () => { events.push('disposed') })
  expect(admitted).toBe(false)
  expect(events).toEqual(['disposed', '/private/auth/login'])
  expect(fetcher.mock.calls[0]?.[0]).toBe('/private/auth/state')
})

it('rejects unavailable or malformed authentication state before plugin activation', async () => {
  await expect(checkBrowserAuthBeforeBoot({ mountPath: '/' }, async () => Response.json({}, { status: 503 }),
    vi.fn(), vi.fn())).rejects.toThrow('Authentication state is unavailable')
  await expect(checkBrowserAuthBeforeBoot({ mountPath: '/' }, async () => Response.json({ authenticated: 'yes' }),
    vi.fn(), vi.fn())).rejects.toThrow('Authentication state is invalid')
})
