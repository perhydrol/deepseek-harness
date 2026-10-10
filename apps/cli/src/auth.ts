/** Boot-free Linux credential maintenance; only selected auth configuration is evaluated. */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { confirm, password } from '@inquirer/prompts'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { loadProfileDirectory, resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import type { PasswordRecord } from '@hydrogen/dsh-browser-auth'
import { AuthError } from '@hydrogen/dsh-browser-auth'
import type { SingleUserConfig } from '@hydrogen/dsh-browser-auth-single-user'
import type { Config as StoreConfiguration } from '@hydrogen/dsh-browser-auth-store-sqlite'
import { Config as ProviderConfig } from '@hydrogen/dsh-browser-auth-single-user'
import { Config as StoreConfig, openAuthStore } from '@hydrogen/dsh-browser-auth-store-sqlite'
import { resolveSingleUserConfig, hashPassword, initializeAuthState, reconfigureAuth, resetPassword } from '@hydrogen/dsh-browser-auth-single-user'
import { collectConfigDumpLayers } from './dump-config.ts'
import { INSTALL_ANCHOR } from './profile-boot.ts'
import type { AuthInvocation } from './args.ts'

/** Terminal adapter keeps injectable test input out of production argv and environment. */
export interface AuthMaintenanceTerminal {
  /** @param message - nonsecret prompt. @returns exact hidden password bytes as a string. */
  password(message: string): Promise<string>
  /** @param message - nonsecret operation summary. @returns explicit operator confirmation. */
  confirm(message: string): Promise<boolean>
  /** @param message - nonsecret status. */
  write(message: string): void
}
const terminal: AuthMaintenanceTerminal = {
  password: message => password({ message, mask: false }),
  confirm: message => confirm({ message, default: false }),
  write: (message) => { process.stderr.write(message + '\n') },
}

/**
 * Maintain one existing profile without applying any application plugin.
 * @param invocation - parsed nonsecret maintenance command.
 * @param io - terminal adapter; production uses hidden interactive input.
 */
export async function runAuthMaintenance(invocation: AuthInvocation, io: AuthMaintenanceTerminal = terminal): Promise<void> {
  if (process.platform !== 'linux') throw new AuthError('auth/unsupported-platform', 'Authentication maintenance requires Linux.')
  const directory = resolveProfileDir(invocation.profile)
  if (!existsSync(join(directory, 'package.json'))) throw new AuthError('auth/invalid-request', 'Authentication maintenance requires an existing profile.')
  const loaded = loadProfileDirectory('dsh auth', directory, INSTALL_ANCHOR)
  if (loaded.skippedBundles.length > 0) throw new AuthError('auth/invalid-request', 'Profile bundles could not be loaded; repair profile dependencies before maintenance.')
  const layers = collectConfigDumpLayers(loaded, false, invocation.patches)
  const entries = applyEntryPatches([], layers.flatMap(layer => layer.patches), () => {
    throw new AuthError('auth/invalid-request', 'Authentication maintenance cannot use a profile with skipped configuration patches.')
  })
  const selected = selectAuthEntries(entries)
  const providerResult = await ProviderConfig['~standard'].validate(evaluateAuthConfig(selected.provider.config, selected.provider.id))
  const storeResult = await StoreConfig['~standard'].validate(evaluateAuthConfig(selected.store.config, selected.store.id))
  if (providerResult.issues !== undefined || storeResult.issues !== undefined) {
    throw new AuthError('auth/invalid-request', 'Authentication provider or storage configuration is invalid; inspect the selected rows.')
  }
  const config = resolveSingleUserConfig(providerResult.value as SingleUserConfig)
  const storage = storeResult.value as StoreConfiguration
  const deployment = {
    publicOrigin: config.trustPolicy.publicOrigin, rpId: new URL(config.trustPolicy.publicOrigin).hostname,
    mountPath: config.trustPolicy.mountPath,
  }
  let newPassword: PasswordRecord | undefined
  if (invocation.command !== 'reconfigure') {
    const candidate = await io.password('New password')
    const repeated = await io.password('Confirm new password')
    if (candidate !== repeated) throw new AuthError('auth/password-policy', 'Passwords do not match; no credentials were changed.')
    newPassword = await hashPassword(candidate, config.password)
  }
  const store = await openAuthStore({ path: storage.path, mode: invocation.command === 'init' ? 'initialize' : 'open' })
  try {
    const current = store.read()
    if (invocation.command === 'init') {
      if (newPassword === undefined) throw new AuthError('auth/password-policy', 'New password is required.')
      const passwordRecord = newPassword
      store.update(() => initializeAuthState(deployment, passwordRecord))
    } else {
      if (current === undefined) throw new AuthError('auth/not-initialized', 'Authentication is not initialized.')
      if (invocation.command === 'reconfigure') {
        const replacement = reconfigureAuth(current, deployment, invocation.clearPasskeys)
        if (!await io.confirm('Reconfigure authentication from ' + JSON.stringify(current.deployment) + ' to ' + JSON.stringify(deployment) + '?')) return
        store.update(() => replacement)
      } else {
        if (JSON.stringify(current.deployment) !== JSON.stringify(deployment)) {
          throw new AuthError('auth/invalid-request', 'Persisted deployment differs; run auth reconfigure before resetting the password.')
        }
        if (newPassword === undefined) throw new AuthError('auth/password-policy', 'New password is required.')
        if (invocation.restoredBackup && !await io.confirm('Revoke every browser session in the restored backup and replace its password?')) return
        const passwordRecord = newPassword
        store.update(() => resetPassword(current, passwordRecord, invocation.clearPasskeys))
      }
    }
    io.write('Authentication maintenance committed. Start the Host and sign in again.')
  } finally { await store.close() }
}

/** @param entries - composed profile rows. @returns exactly one enabled intended provider and store. */
export function selectAuthEntries(entries: readonly EntryOptions[]): { provider: EntryOptions; store: EntryOptions } {
  const providers: EntryOptions[] = []
  const stores: EntryOptions[] = []
  const visit = (rows: readonly EntryOptions[]) => {
    for (const row of rows) {
      if (row.group) {
        const children: unknown = row.config
        if (!Array.isArray(children)) throw new AuthError('auth/invalid-request', 'Profile group must contain entries.')
        visit(children)
        continue
      }
      if (![ '@hydrogen/dsh-browser-auth-single-user', '@hydrogen/dsh-browser-auth-store-sqlite' ].includes(row.name)) continue
      const disabled: unknown = row.disabled
      if (disabled === true) continue
      if (disabled !== undefined && disabled !== null && disabled !== false) {
        throw new AuthError('auth/invalid-request', 'Authentication row ' + row.id + ' disabled must be literal for maintenance.')
      }
      if (row.name.endsWith('store-sqlite')) stores.push(row)
      else providers.push(row)
    }
  }
  visit(entries)
  const provider = providers[0]
  const store = stores[0]
  if (providers.length !== 1 || stores.length !== 1 || provider === undefined || store === undefined) {
    throw new AuthError('auth/invalid-request', 'Profile must contain exactly one enabled single-user provider and one SQLite authentication store.')
  }
  return { provider, store }
}

/**
 * Evaluate only documented home path expressions; never execute arbitrary JavaScript.
 * @param value - selected authentication configuration.
 * @param location - row ID and nested key for actionable diagnostics.
 * @returns literal configuration suitable for the owning plugin validator.
 */
export function evaluateAuthConfig(value: unknown, location: string): unknown {
  if (Array.isArray(value)) return value.map((item, index) => evaluateAuthConfig(item, location + '.' + String(index)))
  if (value === null || typeof value !== 'object') return value
  if ('__jsExpr' in value) {
    const expression = value.__jsExpr
    if (typeof expression === 'string') {
      const match = /^(?:ctx\.)?dshHomePath\((.*)\)$/.exec(expression.trim())
      const argumentsText = match?.[1]
      if (argumentsText !== undefined && /^(?:\s*'[^'\\]*'\s*(?:,\s*'[^'\\]*'\s*)*)?$/.test(argumentsText)) {
        const segments = [...argumentsText.matchAll(/'([^']*)'/g)].map(part => part[1] ?? '')
        return dshHomePath(...segments)
      }
    }
    throw new AuthError('auth/invalid-request', 'Authentication row/key ' + location + ' requires a literal value or dshHomePath string segments for maintenance.')
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, evaluateAuthConfig(item, location + '.' + key)]))
}
