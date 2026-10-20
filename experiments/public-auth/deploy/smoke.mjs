/** Linux Docker smoke: credentials persist across a complete container restart. */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { URLSearchParams } from 'node:url'
import { request } from '../src/http-request.mjs'

const image = process.argv[2]
assert.ok(image, 'Pass the built image tag')
const name = `dsh-smoke-${randomUUID()}`
const volume = `${name}-auth`
// A fixed loopback port avoids the ephemeral range, whose ports a busy runner
// reassigns while a stopped container's forward is unbound.
const proxyUrl = 'http://127.0.0.1:18080'
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const transientCodes = new Set(['ECONNREFUSED', 'ECONNRESET'])
let origin
let password
const ready = async () => {
  for (let attempt = 0; attempt < 120; attempt++) {
    // Podman reports no health state until the first probe completes.
    if (docker('inspect', '--format', '{{if .State.Health}}{{.State.Health.Status}}{{end}}', name) === 'healthy') return
    await setTimeout(1000)
  }
  throw new Error('Container did not become healthy')
}
// Host forwarding can briefly refuse connections after a container restart.
// Only safe GETs are retried; mutations are never replayed.
const send = async (path, options) => {
  let last
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await request(`${proxyUrl}${path}`, options)
    } catch (error) {
      if (!transientCodes.has(error.code) || options.method) throw error
      last = error
      await setTimeout(1000)
    }
  }
  throw last
}
try {
  docker('volume', 'create', volume)
  const initialized = docker('run', '--rm', '-v', `${volume}:/var/lib/dsh-auth`, '--entrypoint', 'node', image,
    '/opt/auth/dist/main.js', 'init', '--state', '/var/lib/dsh-auth')
  password = /Administrator password \(shown once\): (\S+)/u.exec(initialized)?.[1]
  assert.ok(password, 'Initialization did not return an administrator password')
  // A separate exact Host exercises the external proxy configuration.
  origin = 'http://localhost'
  // The probe mirrors the image HEALTHCHECK, which Podman's builder does not preserve.
  docker('run', '-d', '--name', name, '-p', '127.0.0.1:18080:8080', '-v', `${volume}:/var/lib/dsh-auth`,
    '-e', `PUBLIC_ORIGIN=${origin}`, '--health-cmd', 'node /opt/auth/dist/healthcheck.js',
    '--health-interval', '30s', '--health-timeout', '5s', '--health-start-period', '90s', image)
  await ready()
  const anonymous = await send('/', { headers: { host: 'localhost' } })
  await anonymous.body?.cancel()
  assert.equal(anonymous.status, 401)
  const login = await send('/_auth/login', { method: 'POST',
    headers: { host: 'localhost', origin, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }) })
  await login.body?.cancel()
  assert.equal(login.status, 303)
  const cookie = login.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert.ok(cookie)
  const authenticated = async (allowRenewal = false) => {
    let response = await send('/', { headers: { host: 'localhost', cookie } })
    await response.body?.cancel()
    if (allowRenewal && response.status === 401) {
      // Only this safe GET is repeated; mutations are never replayed by the proxy.
      response = await send('/', { headers: { host: 'localhost', cookie } })
      await response.body?.cancel()
    }
    assert.equal(response.status, 200)
  }
  await authenticated()
  const previous = docker('exec', name, 'node', '-e',
    'const fs=require("node:fs"); const pid=Number(fs.readFileSync("/run/dsh/harness.pid","utf8")); process.kill(pid,"SIGKILL"); console.log(pid)')
  let recovered = false
  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const current = docker('exec', name, 'node', '-e',
        'console.log(require("node:fs").readFileSync("/run/dsh/harness.pid","utf8"))')
      if (current !== previous) {
        docker('exec', name, 'node', '/opt/auth/dist/healthcheck.js')
        recovered = true
        break
      }
    } catch (error) {
      // The private file and listener are unavailable while Supervisor restarts DSH.
      if (attempt === 89) throw error
    }
    await setTimeout(1000)
  }
  assert.ok(recovered, 'Supervisor did not recover the DSH child')
  await authenticated(true)
  docker('restart', '--time', '45', name)
  await ready()
  await authenticated()
  const logs = docker('logs', name)
  assert.doesNotMatch(logs, /[?&]token=(?!\[redacted\])/u)
  assert.ok(!logs.includes(password), 'Password leaked to container logs')
  docker('stop', '--time', '45', name)
  assert.equal(docker('inspect', '--format', '{{.State.ExitCode}}', name), '0')
  process.stdout.write('Container login, DSH crash recovery, persistent session, restart, log redaction and shutdown passed.\n')
} catch (error) {
  for (const args of [['logs', '--tail', '100', name], ['inspect', '--format', '{{json .State.Health}}', name], ['port', name, '8080/tcp']]) {
    const result = spawnSync('docker', args, { encoding: 'utf8', timeout: 10_000 })
    let diagnostic = `${result.stdout ?? ''}${result.stderr ?? ''}`.replace(/([?&]token=)[^\s&#]*/giu, '$1[redacted]')
    if (password) diagnostic = diagnostic.replaceAll(password, '[redacted]')
    process.stderr.write(diagnostic)
  }
  throw error
} finally {
  for (const args of [['rm', '-f', '-v', name], ['volume', 'rm', volume]]) {
    try { docker(...args) } catch (error) {
      if (!String(error.stderr).includes('No such container')) {
        process.stderr.write('Smoke cleanup failed; inspect the temporary Docker resources.\n')
        process.exitCode = 1
      }
    }
  }
}
