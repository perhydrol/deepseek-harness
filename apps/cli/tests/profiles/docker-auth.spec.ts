/** The container's private profile resolves through the public boot-free dsh command. */
import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
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
    const authPatch = fileURLToPath(new URL('../../../../deploy/docker/auth.yml', import.meta.url))
    const authBefore = await readFile(authPatch, 'utf8')
    const userPatch = join(home, 'profiles', 'server', 'cordis.patch.yml')
    expect(loadCordisYaml(await readFile(userPatch, 'utf8'))).toEqual([])
    await writeFile(`${userPatch}.tmp`, '- id: ui-settings-general\n  config:\n    welcomeNoticeVersion: "2026-09-28.1"\n')
    await rename(`${userPatch}.tmp`, userPatch)
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      '--import', import.meta.resolve('tsx/esm'),
      fileURLToPath(new URL('../../src/bin.ts', import.meta.url)),
      '--profile', 'server', '--patch', authPatch, '--dump-config',
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
    expect(rows.find(row => row.id === 'ui-settings-general')?.config).toMatchObject({ welcomeNoticeVersion: '2026-09-28.1' })
    expect(await readFile(authPatch, 'utf8')).toBe(authBefore)
  } finally { await rm(home, { recursive: true, force: true }) }
}, 35_000)

it('loads the read-only auth mount from the image command while keeping user preferences in the home volume', async () => {
  const dockerfile = await readFile(new URL('../../../../Dockerfile', import.meta.url), 'utf8')
  const command = JSON.parse(dockerfile.split('\n').find(line => line.startsWith('CMD '))!.slice(4)) as string[]
  expect(command.slice(0, 4)).toEqual(['--profile', 'server', '--patch', '/etc/hydrogen-harness/auth.yml'])
  const compose = loadCordisYaml(await readFile(new URL('../../../../deploy/docker/compose.yaml', import.meta.url), 'utf8'))
  expect(compose).toMatchObject({ services: { harness: { volumes: [
    'home:/var/lib/dsh', 'workspace:/workspace',
    { type: 'bind', source: './auth.yml', target: '/etc/hydrogen-harness/auth.yml', read_only: true, bind: { create_host_path: false } },
  ] } } })
})
