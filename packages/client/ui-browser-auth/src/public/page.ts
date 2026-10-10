/** Independent semantic HTML pages using only the authentication API. */
import { AuthClient, AuthPageError } from './auth-client.ts'
import type { ManagementAction, Reauthentication, SecurityState } from './auth-client.ts'
import { authTranslator } from './locales.ts'
import type { AuthKey } from './locales.ts'

/**
 * Render login or security controls without activating business plugins.
 * *
 * @param root - owned page container.
 * *
 * @param client - in-memory proof and authentication transport.
 * *
 * @param mode - public login or authenticated security page.
 * *
 * @param navigate - full-document navigation after authentication changes.
 * *
 * @param language - browser locale.
 * *
 * @returns after initial authentication state and page contents load.
 */
export async function mountAuthPage(
  root: HTMLElement, client: AuthClient, mode: 'login' | 'security', navigate: (path: string) => void,
  language: string,
): Promise<void> {
  const t = authTranslator(language)
  const doc = root.ownerDocument
  const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string): HTMLElementTagNameMap[K] => {
    const node = doc.createElement(tag)
    if (text !== undefined) node.textContent = text
    return node
  }
  let busy = false
  let status = element('p')
  status.setAttribute('role', 'status')
  status.setAttribute('aria-live', 'polite')
  const heading = (key: AuthKey, level: 'h1' | 'h2' = 'h2') => element(level, t(key))
  const field = (parent: HTMLElement, key: AuthKey, type = 'text') => {
    const label = element('label', t(key))
    const input = element('input')
    input.type = type
    input.autocomplete = type === 'password' ? (key === 'currentPassword' || key === 'password' ? 'current-password' : 'new-password') : 'off'
    label.append(input)
    parent.append(label)
    return input
  }
  const button = (parent: HTMLElement, key: AuthKey, run: () => Promise<void>) => {
    const node = element('button', t(key))
    node.type = 'button'
    node.addEventListener('click', () => { void action(run) })
    parent.append(node)
    return node
  }
  const initialize = (key: AuthKey, description: AuthKey) => {
    root.replaceChildren(element('p', t('title')), heading(key, 'h1'), element('p', t(description)))
    status = element('p')
    status.setAttribute('role', 'status')
    status.setAttribute('aria-live', 'polite')
    root.append(status)
  }
  const setBusy = (value: boolean) => {
    busy = value
    root.setAttribute('aria-busy', String(value))
    for (const control of root.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input,button,select')) {
      control.disabled = value || control.dataset.unavailable === 'true'
    }
  }
  async function action(run: () => Promise<void>): Promise<void> {
    if (busy) return
    setBusy(true)
    status.textContent = t('pending')
    try {
      await run()
      status.textContent = t('saved')
    } catch (error) {
      status.textContent = t(errorKey(error))
      if (error instanceof AuthPageError && error.code !== 'auth/network') {
        try {
          const state = await client.refresh()
          if (mode === 'security' && !state.authenticated) navigate(client.mountPath + 'auth/login')
        } catch (_refreshError) { /* The operation's visible failure retains the retry instruction. */ }
      }
    } finally { setBusy(false) }
  }
  root.replaceChildren(element('p', t('loading')))
  doc.documentElement.lang = language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
  doc.title = t(mode === 'login' ? 'login' : 'security') + ' · ' + t('title')
  try {
    const state = await client.refresh()
    if (mode === 'login') {
      if (state.authenticated) { navigate(client.mountPath); return }
      initialize('login', 'loginDescription')
      const form = element('form')
      const password = field(form, 'password', 'password')
      password.required = true
      const submit = element('button', t('loginPassword'))
      submit.type = 'submit'
      form.append(submit)
      form.addEventListener('submit', (event) => {
        event.preventDefault()
        const value = password.value
        password.value = ''
        void action(async () => { await client.loginPassword(value); navigate(client.mountPath) })
      })
      root.insertBefore(form, status)
      const passkey = button(root, 'loginPasskey', async () => { await client.loginPasskey(); navigate(client.mountPath) })
      if (!state.passkey || !globalThis.isSecureContext || typeof PublicKeyCredential === 'undefined') {
        passkey.dataset.unavailable = 'true'
        passkey.disabled = true
      }
      password.focus()
      return
    }
    if (!state.authenticated) { navigate(client.mountPath + 'auth/login'); return }
    await renderSecurity()
  } catch (error) {
    root.replaceChildren(heading(mode === 'login' ? 'login' : 'security', 'h1'), status)
    status.textContent = t(errorKey(error))
  }

  async function renderSecurity(): Promise<void> {
    const security = await client.security()
    initialize('security', 'securityDescription')
    const back = element('a', t('back'))
    back.href = client.mountPath
    root.insertBefore(back, status)
    button(root, 'logout', async () => { await client.logout(); navigate(client.mountPath + 'auth/login') })
    const verification = element('section')
    verification.append(heading('reauth'), element('p', t('reauthDescription')))
    const methodLabel = element('label', t('method'))
    const method = element('select')
    for (const [value, key] of [['password', 'passwordMethod'], ['passkey', 'passkeyMethod']] as const) {
      const option = element('option', t(key))
      option.value = value
      method.append(option)
    }
    methodLabel.append(method)
    verification.append(methodLabel)
    const current = field(verification, 'currentPassword', 'password')
    method.addEventListener('change', () => {
      current.value = ''
      const label = current.closest('label')
      if (label !== null) label.hidden = method.value === 'passkey'
    })
    root.append(verification)
    const proof = (): Reauthentication => {
      const value = current.value
      current.value = ''
      return method.value === 'passkey' ? { method: 'passkey' } : { method: 'password', password: value }
    }
    const authorize = (operation: ManagementAction, target = '') => client.reauthenticate(operation, proof(), target)
    const keys = element('section')
    keys.append(heading('passkeys'), element('p', t('sessionCount') + ': ' + String(security.sessionCount)))
    if (security.passkeys.length === 0) keys.append(element('p', t('noPasskeys')))
    for (const key of security.passkeys) appendKey(keys, key, authorize)
    const label = field(keys, 'label')
    button(keys, 'register', async () => {
      const grant = await authorize('register')
      await client.register(grant, label.value)
      await renderSecurity()
    })
    root.append(keys)
    const passwordSection = element('section')
    passwordSection.append(heading('changePassword'))
    const password = field(passwordSection, 'newPassword', 'password')
    const confirmation = field(passwordSection, 'confirmPassword', 'password')
    button(passwordSection, 'changePassword', async () => {
      const value = password.value
      const repeated = confirmation.value
      password.value = ''; confirmation.value = ''
      if (value !== repeated) throw new AuthPageError('auth/password-mismatch')
      const grant = await authorize('password')
      await client.changePassword(grant, value)
      navigate(client.mountPath + 'auth/login')
    })
    root.append(passwordSection)
    button(root, 'logoutAll', async () => {
      await client.logoutAll(await authorize('logout-all'))
      navigate(client.mountPath + 'auth/login')
    })
    root.append(status)
  }

  function appendKey(parent: HTMLElement, key: SecurityState['passkeys'][number],
    authorize: (action: ManagementAction, target?: string) => Promise<string>): void {
    const row = element('article')
    const label = field(row, 'label')
    label.value = key.label
    row.append(element('p', t('created') + ': ' + new Date(key.createdAt).toLocaleString(language)),
      element('p', t('lastUsed') + ': ' + (key.lastUsedAt === null ? t('neverUsed') : new Date(key.lastUsedAt).toLocaleString(language))))
    button(row, 'rename', async () => { await client.rename(key.id, await authorize('rename', key.id), label.value); await renderSecurity() })
    button(row, 'remove', async () => { await client.delete(key.id, await authorize('delete', key.id)); navigate(client.mountPath + 'auth/login') })
    parent.append(row)
  }
}

function errorKey(error: unknown): AuthKey {
  if (!(error instanceof AuthPageError)) return 'unavailable'
  switch (error.code) {
    case 'auth/invalid-credentials': return 'invalidCredentials'
    case 'auth/forbidden': case 'auth/challenge': case 'auth/reauth-required': return 'forbidden'
    case 'auth/network': return 'network'
    case 'auth/cancelled': return 'cancelled'
    case 'auth/unsupported': return 'unsupported'
    case 'auth/busy': return 'busy'
    case 'auth/capacity': return 'capacity'
    case 'auth/password-policy': return 'passwordPolicy'
    case 'auth/password-mismatch': return 'passwordMismatch'
    default: return 'unavailable'
  }
}
