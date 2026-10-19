/** Better Auth owns passwords, database sessions, cookies, and login rate limits. */
import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { betterAuth } from 'better-auth'
import { getMigrations } from 'better-auth/db/migration'

/** Internal identifier for the sole account; no mail is sent. */
export const OWNER_EMAIL = 'owner@dsh.invalid'

/** Inputs shared by local initialization and the public proxy. */
export interface AuthConfig {
  stateDirectory: string
  publicOrigin: string
  sessionSeconds: number
  loginAttempts: number
  loginWindowSeconds: number
}

/** Open persisted Better Auth state with public registration disabled by default. */
export function openAuth(config: AuthConfig, initialize = false) {
  const secret = readFileSync(join(config.stateDirectory, 'secret'), 'utf8').trim()
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('Invalid authentication secret')
  const database = new DatabaseSync(join(config.stateDirectory, 'auth.sqlite'))
  const auth = betterAuth({
    database,
    secret,
    baseURL: config.publicOrigin,
    basePath: '/_auth/api',
    trustedOrigins: [config.publicOrigin],
    emailAndPassword: { enabled: true, disableSignUp: !initialize, minPasswordLength: 12 },
    session: { expiresIn: config.sessionSeconds, disableSessionRefresh: true, cookieCache: { enabled: false } },
    rateLimit: {
      enabled: true, storage: 'database', window: config.loginWindowSeconds, max: config.loginAttempts,
      customRules: {
        '/get-session': false, '/sign-out': false,
        '/sign-in/email': { window: config.loginWindowSeconds, max: config.loginAttempts },
      },
    },
    advanced: {
      useSecureCookies: config.publicOrigin.startsWith('https:'),
      defaultCookieAttributes: { httpOnly: true, sameSite: 'strict', path: '/' },
      cookies: { session_token: { name: config.publicOrigin.startsWith('https:') ? 'dsh-proxy' : 'dsh-proxy-local' } },
      ipAddress: { ipAddressHeaders: ['x-proxy-client-ip'] },
      database: { validateSchema: !initialize },
    },
    telemetry: { enabled: false },
  })
  return { auth, database }
}

/** Initialize one administrator offline; registration is never mounted publicly. */
export async function initialize(directory: string, password: string): Promise<void> {
  if (password.length < 12 || password.length > 128) throw new Error('Password must contain 12 to 128 characters')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  writeFileSync(join(directory, 'secret'), randomBytes(32).toString('base64url') + '\n', { flag: 'wx', mode: 0o600 })
  const { auth, database } = openAuth({
    stateDirectory: directory, publicOrigin: 'http://127.0.0.1',
    sessionSeconds: 30 * 86400, loginAttempts: 5, loginWindowSeconds: 60,
  }, true)
  try {
    await (await getMigrations(auth.options)).runMigrations()
    await auth.api.signUpEmail({ body: { email: OWNER_EMAIL, password, name: 'Owner' } })
  } finally {
    database.close()
  }
}
