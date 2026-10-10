/** Optional authenticated settings entry and session-loss cleanup owner. */
import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { SecurityEntry } from './SettingsEntry.tsx'
import { discardPrivatePage } from './page-lifecycle.ts'
import { SessionGuard } from './session-guard.ts'
import { zh, en } from '../public/locales.ts'
import type { AuthKey } from '../public/locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Login, security management and the application settings entry. */
    'browser.auth': AuthKey
  }
}

/** UI registration and Connection lifecycle providers. */
export const inject = ['slots', 'locale', 'connection']
/**
 * @param ctx - optional authenticated browser plugin context.
 */
export function apply(ctx: Context): void {
  const bootstrap = (globalThis as { __DSH_BROWSER_AUTH__?: { mountPath: string } }).__DSH_BROWSER_AUTH__
  if (bootstrap === undefined) throw new Error('Single-user browser authentication bootstrap is missing.')
  const connection = ctx.get('connection') as ConnectionHandle
  const login = bootstrap.mountPath + 'auth/login'
  ctx.effect(() => ctx.locale.register('browser.auth', { zh, en }), 'browser-auth: locale')
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item', id: 'browser-security', order: 30, locale: 'browser.auth',
    inject: () => ({ openSecurity: () => { location.assign(bootstrap.mountPath + 'auth/security') } }),
  }, SecurityEntry))
  ctx.effect(() => {
    const guard = new SessionGuard(bootstrap.mountPath, async () => {
      document.body.replaceChildren()
      try { await ctx.root.fiber.dispose() } finally { location.replace(login) }
    })
    const check = () => { void guard.check().catch((error: unknown) => { console.error(error) }) }
    const unsubscribe = connection.state.subscribe(() => {
      if (connection.state.getSnapshot() !== 'connected') check()
    })
    const hide = (event: PageTransitionEvent) => {
      discardPrivatePage(event, window, () => {
        guard.stop()
        document.body.replaceChildren()
        void ctx.root.fiber.dispose().catch((error: unknown) => { console.error(error) })
      }, () => { location.reload() })
    }
    const show = (event: PageTransitionEvent) => { if (event.persisted) location.reload(); else check() }
    window.addEventListener('focus', check)
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', show)
    check()
    return () => {
      guard.stop(); unsubscribe()
      window.removeEventListener('focus', check)
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', show)
    }
  }, 'browser-auth: session lifetime')
}
