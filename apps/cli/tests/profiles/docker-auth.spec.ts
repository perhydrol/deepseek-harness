/** The container's private profile resolves through the public boot-free dsh command. */
import { execFile } from 'node:child_process'
import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { loadCordisYaml } from '../../../../scripts/cordis-yaml.ts'

it('composes the Docker profile with one provider, loopback proxy trust and a required gate', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-docker-profile-'))
  try {
    await cp(new URL('../../../../deploy/docker/profile/', import.meta.url), join(home, 'profiles', 'server'), { recursive: true })
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      '--import', import.meta.resolve('tsx/esm'),
      fileURLToPath(new URL('../../src/bin.ts', import.meta.url)),
      '--profile', 'server', '--dump-config',
    ], {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      env: { ...process.env, DSH_HOME: home }, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    })
    expect(stderr).not.toContain('skipping profile bundle')
    const parsed = loadCordisYaml(stdout)
    if (!Array.isArray(parsed)) throw new Error('Expected a composed Loader entry list.')
    const rows = parsed as EntryOptions[]
    expect(rows.find(row => row.id === 'browser-auth')?.disabled).toBe(true)
    expect(rows.filter(row => row.name === '@hydrogen/dsh-browser-auth-single-user' && row.disabled !== true)).toHaveLength(1)
    expect(rows.find(row => row.id === 'browser-auth-single-user')?.config).toMatchObject({
      publicOrigin: 'https://harness.example.com', rpId: 'harness.example.com',
      upstream: { kind: 'proxy', trustedPeers: ['127.0.0.1/32'], clientIpHeader: 'x-hydrogen-client-ip' },
    })
    expect(rows.find(row => row.id === 'webserver')?.config).toMatchObject({ requireRequestGate: true })
    expect(rows.find(row => row.id === 'ui-settings')?.config).toMatchObject({ allowRemotePersistence: true })
  } finally { await rm(home, { recursive: true, force: true }) }
}, 35_000)
