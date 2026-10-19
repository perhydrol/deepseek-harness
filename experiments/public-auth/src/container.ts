/** Supervisor child entrypoints for the Linux single-container deployment. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { createLaunchOutput } from './launch-output.ts'
import { createProxy } from './proxy.ts'

const file = '/run/dsh/launch-url'
const internalOrigin = 'http://127.0.0.1:3081'

try {
  if (process.argv[2] === 'harness') {
    await mkdir('/run/dsh', { recursive: true, mode: 0o700 })
    await rm(file, { force: true })
    const child = spawn(process.execPath, ['/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
      'web', '--no-open', '--host', '127.0.0.1', '--port', '3081'], { stdio: ['ignore', 'pipe', 'pipe'] })
    child.once('spawn', () => {
      void writeFile('/run/dsh/harness.pid', String(child.pid), { mode: 0o600 }).catch(() => {
        console.error('Cannot publish the private DSH process identifier; stopping DSH.')
        child.kill('SIGTERM')
        process.exitCode = 1
      })
    })
    const output = createLaunchOutput(file, internalOrigin, line => { process.stdout.write(line) })
    child.stdout.pipe(output.stdout)
    child.stderr.pipe(output.stderr)
    const captured = output.finished().catch(() => {
      child.kill('SIGTERM')
      process.exitCode = 1
      console.error('Private startup capture failed; DSH stopped. Check /run/dsh permissions.')
    })
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { child.kill(signal) })
    const [code, signal] = await once(child, 'close') as [number | null, NodeJS.Signals | null]
    await captured
    await rm(file, { force: true })
    process.exitCode = process.exitCode || code || (signal ? 1 : 0)
  } else if (process.argv[2] === 'proxy') {
    const publicOrigin = process.env.PUBLIC_ORIGIN
    if (!publicOrigin) throw new Error('Set PUBLIC_ORIGIN to the external HTTPS origin')
    // Supervisor restarts this process if DSH does not become ready within the startup budget.
    const deadline = Date.now() + 60_000
    for (;;) {
      let ready = false
      try {
        const url = new URL((await readFile(file, 'utf8')).trim())
        if (url.origin !== internalOrigin) throw new Error('Unexpected internal origin')
        const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
        await response.body?.cancel()
        ready = response.status === 303
      } catch (error) {
        // The supervised DSH process may still be starting or replacing its launch URL.
        if (Date.now() >= deadline) throw new Error('DSH readiness timed out; inspect the harness logs', { cause: error })
      }
      if (ready) break
      if (Date.now() >= deadline) throw new Error('DSH readiness timed out; inspect the harness logs')
      await setTimeout(500)
    }
    const app = await createProxy({ publicOrigin, launchUrlFile: file,
      stateDirectory: '/var/lib/dsh-auth', sessionSeconds: Number(process.env.SESSION_DAYS ?? '30') * 86400,
      loginAttempts: Number(process.env.LOGIN_ATTEMPTS ?? '5'), loginWindowSeconds: Number(process.env.LOGIN_WINDOW_SECONDS ?? '60') })
    await app.listen({ host: '0.0.0.0', port: 8080 })
    console.log('Authentication proxy ready on port 8080')
    for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1 })
    })
  } else { throw new Error('Expected harness or proxy supervisor mode') }
} catch {
  console.error('Container service failed; check PUBLIC_ORIGIN, initialized auth state, and private directory permissions.')
  process.exitCode = 1
}
