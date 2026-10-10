/** Host registration of shared Web and desktop developer-tool preferences. */
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { BrowserSettingsFields, BROWSER_SETTINGS_CONFIG_GLOBAL } from './browser-settings-config.ts'

import type { Volatile, Context } from '@deepseek-ai/cordis'

import z from '@deepseek-ai/schemastery'
import { DeveloperToolsSettingsFields } from './developer-tools-settings.ts'

/** Runtime preferences projected to the browser. */
export interface Config {
  /** Whether developer tools are enabled. */
  enabled: Volatile<boolean>
  /** Allow remote pages to read and persist Host settings; enable only behind operator authentication. */
  allowRemotePersistence: boolean
}

/** Live preferences projected to the browser. */
export const Config = z.object({
  allowRemotePersistence: BrowserSettingsFields['allowRemotePersistence'],
  enabled: DeveloperToolsSettingsFields['enabled'].volatile(),
})

/** Host preferences are consumed through the configuration form projection.
 * @param ctx Plugin context used for optional settings presentation.
 * @param config Validated persistence and presentation options.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: BROWSER_SETTINGS_CONFIG_GLOBAL,
      value: { allowRemotePersistence: config.allowRemotePersistence } })
  })
  ctx.inject(['settings'], (child) => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
}
