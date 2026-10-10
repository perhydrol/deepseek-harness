/** Public settings-persistence options shared by the Host and browser bootstrap. */
import z from '@deepseek-ai/schemastery'

/** Configuration fields for deployments that authenticate a remote operator. */
export const BrowserSettingsFields = {
  allowRemotePersistence: z.boolean().default(false),
}

/** Validate the browser's public persistence choice before settings initialization. */
export const BrowserSettingsConfig = z.object(BrowserSettingsFields)

/** Page-global key carrying no credentials or settings values. */
export const BROWSER_SETTINGS_CONFIG_GLOBAL = '__DSH_SETTINGS_BROWSER__'
