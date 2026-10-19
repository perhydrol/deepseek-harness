/** Standalone CLI for initializing and running the single-owner proxy. */
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { initialize } from './auth.ts'
import { createProxy } from './proxy.ts'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    state: { type: 'string', default: './state' },
    'password-file': { type: 'string' },
    origin: { type: 'string' },
    'launch-url-file': { type: 'string' },
    bind: { type: 'string', default: '127.0.0.1' },
    port: { type: 'string', default: '8080' },
    'session-days': { type: 'string', default: '30' },
    'login-attempts': { type: 'string', default: '5' },
    'login-window-seconds': { type: 'string', default: '60' },
  },
})
try {
  if (positionals[0] === 'init') {
    const password = values['password-file']
      ? readFileSync(values['password-file'], 'utf8').trimEnd() : randomBytes(24).toString('base64url')
    await initialize(values.state, password)
    console.log(values['password-file'] ? 'Administrator initialized.' : `Administrator password (shown once): ${password}`)
  } else if (positionals[0] === 'serve' && values.origin && values['launch-url-file']) {
    const app = await createProxy({
      publicOrigin: values.origin, stateDirectory: values.state, launchUrlFile: values['launch-url-file'],
      sessionSeconds: Number(values['session-days']) * 86400,
      loginAttempts: Number(values['login-attempts']), loginWindowSeconds: Number(values['login-window-seconds']),
    })
    const port = Number(values.port)
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid listen port')
    const address = await app.listen({ host: values.bind, port })
    console.log(`Authentication proxy listening on ${address}; sign in at /_auth/login`)
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1 })
    })
  } else {
    throw new Error('Usage: node dist/main.js init [--state DIR] [--password-file FILE] | serve --origin URL --launch-url-file FILE [--state DIR]')
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Startup failed')
  process.exitCode = 1
}
