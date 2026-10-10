/** Authentication fetches own CSRF state and never expose passwords in URLs. */
import { expect, it, vi } from 'vitest'
import { AuthClient } from '../src/public/auth-client.ts'

it('sends login proof in JSON and refreshes consumed pre-auth state after a rejected password', async () => {
  const fetcher = vi.fn<typeof fetch>()
  fetcher.mockResolvedValueOnce(Response.json({ authenticated: false, csrf: 'first', password: true, passkey: false }))
  fetcher.mockResolvedValueOnce(Response.json({ error: { code: 'auth/invalid-credentials' } }, { status: 401 }))
  fetcher.mockResolvedValueOnce(Response.json({ authenticated: false, csrf: 'fresh', password: true, passkey: false }))
  const client = new AuthClient('/', fetcher)
  await client.refresh()
  await expect(client.loginPassword('exact password')).rejects.toMatchObject({ code: 'auth/invalid-credentials' })
  expect(fetcher.mock.calls[1]?.[0]).toBe('/auth/password/login')
  const sent = fetcher.mock.calls[1]?.[1]
  expect(new Headers(sent?.headers).get('x-dsh-csrf')).toBe('first')
  expect(sent?.body).toBe(JSON.stringify({ password: 'exact password' }))
  expect(client.state?.csrf).toBe('fresh')
})

it('rejects malformed public state rather than treating it as an authenticated response', async () => {
  const client = new AuthClient('/', async () => Response.json({ authenticated: true }))
  await expect(client.refresh()).rejects.toMatchObject({ code: 'auth/unavailable' })
  expect(client.state).toBeUndefined()
})
