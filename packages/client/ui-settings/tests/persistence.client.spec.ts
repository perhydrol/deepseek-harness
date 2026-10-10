/** Host settings remain available only to local or explicitly enabled remote pages. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import { DeveloperToolsSettingsSchema } from '../src/developer-tools-settings.ts'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '../src/client/index.ts'

afterEach(() => { vi.unstubAllGlobals() })

it.each([
  { isLoopback: true, allowRemotePersistence: false, reads: true },
  { isLoopback: false, allowRemotePersistence: false, reads: false },
  { isLoopback: false, allowRemotePersistence: true, reads: true },
])('selects Host settings for $isLoopback / $allowRemotePersistence', async ({ isLoopback, allowRemotePersistence, reads }) => {
  vi.stubGlobal('__DSH_SETTINGS_BROWSER__', { allowRemotePersistence })
  const ctx = new Context()
  const view = { ns: 'ui-settings', schema: DeveloperToolsSettingsSchema.toJSON(), value: { enabled: true },
    base: { enabled: true }, user: {}, revision: 1, applies: 'live' as const, secrets: [], autoGenerate: false }
  const describe = vi.fn(async () => ({ ok: true as const,
    value: { writable: true, hasDocument: true, namespaces: [view] } }))
  const mutate = vi.fn(async () => ({ ok: true as const, value: { ...view, value: { enabled: false }, revision: 2 } }))
  const remote = new TestRemote(ctx, { settings: { describe, mutate } })
  remote.$host = { home: undefined, isLoopback }
  try {
    await ctx.plugin({ inject: [...inject], apply }).await()
    await ctx.configForms.describe().ensure()
    expect(describe).toHaveBeenCalledTimes(reads ? 1 : 0)
    expect(ctx.configForms.describe().getSnapshot().status).toBe(reads ? 'ready' : 'unavailable')
    await ctx.configForms.developerTools.setEnabled(false)
    expect(mutate).toHaveBeenCalledTimes(reads ? 1 : 0)
    expect(ctx.configForms.developerTools.enabled.getSnapshot()).toBe(false)
    expect(remote.$host.isLoopback).toBe(isLoopback)
  } finally { await ctx.fiber.dispose() }
})
