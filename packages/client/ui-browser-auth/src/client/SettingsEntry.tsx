/** Settings link to the separately authenticated security page. */
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-locale/client'

/** Settings contribution receives navigation from its owning client plugin. */
export type SecurityEntryProps = PropsRuntime<'settings.general.item'> & PropsLocale<'browser.auth'> & {
  readonly openSecurity: () => void
}
/**
 * @param props - localized settings row.
 * @returns the security-page entry action.
 */
export function SecurityEntry({ t, openSecurity }: SecurityEntryProps) {
  return <Button variant="outline" onClick={openSecurity}>{t('security')}</Button>
}
