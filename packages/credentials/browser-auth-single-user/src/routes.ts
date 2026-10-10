/** Owned HTTP adapter with bounded bodies, redacted failures and drainable requests. */
import type { Context } from '@deepseek-ai/cordis'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { AuthError } from '@hydrogen/dsh-browser-auth'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { browserRequest, readJson, resolveRequestClient } from './request.ts'
import type { AuthOperations } from './operations.ts'

/**
 * Register the authentication route and drain all handlers before operation shutdown.
 * *
 * @param ctx - registration owner.
 * *
 * @param operations - initialized authentication operations.
 * *
 * @returns asynchronous cleanup with registration removal before draining.
 */
export function registerAuthRoutes(ctx: Context, operations: AuthOperations): () => Promise<void> {
  const base = '/auth'
  const active = new Set<Promise<void>>()
  let stopping = false
  const dispose = ctx.webServer.register({
    kind: 'prefix', path: base,
    handler: (request, response) => {
      if (stopping) { response.writeHead(503, { 'cache-control': 'no-store' }); response.end(); return }
      const done = handle(request, response)
      active.add(done)
      void done.then(() => { active.delete(done) }, () => { active.delete(done) })
      return done
    },
  })
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('cache-control', 'no-store')
    response.setHeader('content-type', 'application/json; charset=utf-8')
    try {
      const facts = browserRequest(request)
      resolveRequestClient(facts, operations.config.trustPolicy)
      const operation = new URL(facts.url, operations.config.trustPolicy.publicOrigin).pathname.slice(base.length + 1)
      const body = facts.method === 'POST' ? await readJson(request, operations.config.bodyLimitBytes) : {}
      const result = await operations.execute(operation, facts, body)
      if (result.cookies.length > 0) response.setHeader('set-cookie', result.cookies)
      response.writeHead(200)
      response.end(JSON.stringify(result.body))
    } catch (error) {
      const code = error instanceof AuthError ? error.code : 'auth/unavailable'
      const status = code === 'auth/forbidden' ? 403 : code === 'auth/invalid-credentials' ? 401
        : code === 'auth/busy' || code === 'auth/capacity' ? 429
          : ['auth/storage', 'auth/unavailable', 'auth/ownership'].includes(code) ? 503 : 400
      response.writeHead(status)
      response.end(JSON.stringify({ error: { code } }))
    }
  }
  return async () => {
    stopping = true
    dispose()
    await operations.close()
    await Promise.all(active)
  }
}
