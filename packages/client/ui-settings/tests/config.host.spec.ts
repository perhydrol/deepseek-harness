import { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'
import * as HostPlugin from '../src/index.ts'
import { liveConfig, omitsGeneratedPage } from '../../../settings/settings/tests/live-config.ts'
import { plainConfig } from '../../../settings/settings/src/schema.ts'
import { Config, apply } from '../src/index.ts'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'

it('defaults on, persists valid choices and removes its schema on disposal', async () => {
  const ctx = new Context()
  const configuration = await liveConfig(ctx, { Config, apply })
  onTestFinished(() => ctx.fiber.dispose())
  expect(plainConfig(configuration.fiber.config)).toEqual({ enabled: true, allowRemotePersistence: false })
  await configuration.update({ enabled: false })
  expect(plainConfig(configuration.fiber.config)).toEqual({ enabled: false, allowRemotePersistence: false })
  await expect(configuration.update({ enabled: 'yes' })).rejects.toThrow()
  await expect(configuration.update({ allowRemotePersistence: 'yes' })).rejects.toThrow()
  await configuration.fiber.dispose()
})

it('keeps its own instance off the generated Settings pages', () => omitsGeneratedPage(ctx => ctx.plugin(HostPlugin)))

it('publishes the validated remote persistence choice from the Host', async () => {
  const ctx = new Context()
  try {
    const config = Config({ enabled: true, allowRemotePersistence: true })
    apply(ctx, config)
    const rows: IndexInjection[] = []
    ctx.emit('webserver/index-inject', rows)
    expect(rows).toContainEqual({ kind: 'global', name: '__DSH_SETTINGS_BROWSER__', value: { allowRemotePersistence: true } })
    expect(Config({ enabled: true })).toMatchObject({ allowRemotePersistence: false })
  } finally { await ctx.fiber.dispose() }
})
