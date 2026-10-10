/** Optional authentication composition retains the default provider outside this layer. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { loadCordisYaml } from '../../../../scripts/cordis-yaml.ts'

function patches(relative: string): PatchOptions[] {
  const value = loadCordisYaml(readFileSync(new URL(relative, import.meta.url), 'utf8'))
  if (!Array.isArray(value)) throw new Error('Expected a patch list.')
  return value as PatchOptions[]
}

it('requires admission and enables exactly one provider only when selected', () => {
  const base = [
    ...patches('../../base/cordis.patch.yml'),
    ...patches('../../web-app/cordis.patch.yml'),
  ]
  const warnings: string[] = []
  const defaults = applyEntryPatches([], base, warning => warnings.push(warning))
  expect(defaults.find(row => row.id === 'browser-auth')?.name).toBe('@hydrogen/dsh-browser-auth-launch-token')
  const composed = applyEntryPatches([], [...base, ...patches('../cordis.patch.yml')], warning => warnings.push(warning))
  expect(warnings).toEqual([])
  expect(composed.find(row => row.id === 'browser-auth')?.disabled).toBe(true)
  expect(composed.filter(row => row.name?.includes('browser-auth-single-user') && row.disabled !== true)).toHaveLength(1)
  expect(composed.find(row => row.id === 'webserver')?.config).toMatchObject({ requireRequestGate: true, compression: 'gzip' })
  const edited = applyEntryPatches(composed, [{ id: 'browser-auth-single-user', config: {
    publicOrigin: 'https://harness.example', rpId: 'harness.example',
  } }], warning => warnings.push(warning))
  expect(edited.find(row => row.id === 'browser-auth-single-user')?.config).toMatchObject({ rpId: 'harness.example' })
  expect(warnings).toEqual([])
})

it('declares every inserted plugin as a direct private bundle dependency', () => {
  const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    name: string
    private: boolean
    dependencies: Record<string, string>
  }
  expect(manifest.name).toBe('@hydrogen/dsh-single-user-auth')
  expect(manifest.private).toBe(true)
  const document = patches('../cordis.patch.yml')
  for (const patch of document) for (const row of patch.insert ?? []) {
    expect(manifest.dependencies[row.name]).toBe('workspace:*')
  }
})
