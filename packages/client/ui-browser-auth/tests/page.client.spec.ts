// @vitest-environment jsdom
/** Public login presents only authentication inputs and clears used passwords. */
import { afterEach, expect, it, vi } from 'vitest'
import { getByLabelText, getByRole } from '@testing-library/dom'
import { AuthClient } from '../src/public/auth-client.ts'
import { mountAuthPage } from '../src/public/page.ts'

afterEach(() => { document.body.replaceChildren() })

it('renders password fallback without loading business bootstrap', async () => {
  const root = document.createElement('main')
  document.body.append(root)
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({
    authenticated: false, csrf: 'proof', password: true, passkey: false,
  }))
  await mountAuthPage(root, new AuthClient('/', fetcher), 'login', vi.fn(), 'en')
  expect(getByRole(root, 'heading', { name: 'Sign in' })).toBeTruthy()
  expect(getByLabelText(root, 'Password')).toHaveProperty('type', 'password')
  expect(getByRole(root, 'button', { name: 'Sign in with passkey' })).toHaveProperty('disabled', true)
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('clears the password immediately and disables actions while login is pending', async () => {
  const root = document.createElement('main')
  document.body.append(root)
  const pending = Promise.withResolvers<Response>()
  const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValueOnce(Response.json({ authenticated: false, csrf: 'proof', password: true, passkey: false }))
    .mockReturnValueOnce(pending.promise)
  await mountAuthPage(root, new AuthClient('/', fetcher), 'login', vi.fn(), 'en')
  const input = getByLabelText<HTMLInputElement>(root, 'Password')
  input.value = 'private password'
  getByRole(root, 'button', { name: 'Sign in with password' }).click()
  expect(input.value).toBe('')
  expect(getByRole(root, 'button', { name: 'Sign in with password' })).toHaveProperty('disabled', true)
  fetcher.mockResolvedValue(Response.json({ authenticated: false, csrf: 'fresh', password: true, passkey: false }))
  pending.resolve(Response.json({ error: { code: 'auth/invalid-credentials' } }, { status: 401 }))
  await vi.waitFor(() => { expect(getByRole(root, 'status').textContent).toContain('Verification failed') })
})

it('renders the authenticated security controls from their separate JSON endpoint', async () => {
  const root = document.createElement('main')
  document.body.append(root)
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    if (input === '/auth/state') return Response.json({
      authenticated: true, csrf: 'proof', password: true, passkey: false,
    })
    if (input === '/auth/security/state') return Response.json({ sessionCount: 1, passkeys: [] })
    throw new Error('Unexpected authentication endpoint')
  })
  await mountAuthPage(root, new AuthClient('/', fetcher), 'security', vi.fn(), 'en')
  expect(root.textContent).toMatchInlineSnapshot('"DeepSeek HarnessSign-in and securityManage this browser session, passkeys and your sign-in password.Back to appSign out of this browserVerify sensitive changesEach sensitive change requires fresh verification. Your password is not retained.Verification methodPasswordPasskeyCurrent passwordPasskeysActive browser sessions: 1No passkeys added yet.Passkey nameAdd passkeyChange passwordNew passwordRepeat new passwordChange passwordSign out of all browsers"')
})
