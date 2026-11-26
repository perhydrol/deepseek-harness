/**
 * @perhydrol/dsh-static-cache — Host half of the browser static-asset cache.
 *
 * It serves one service worker script from a named route and injects its
 * registration into the Web index. It changes no authentication behavior: the
 * route sits behind the deployment's existing proxy, and the worker only
 * replays bytes the authenticated page already fetched with its cookie.
 *
 * @module @perhydrol/dsh-static-cache
 */

import { readFileSync } from 'node:fs'
import { resolveConfig, type ResolvedStaticCacheConfig } from './config.js'
import { registerScript } from './register.js'

/** Stable Cordis plugin name. */
export const name = 'static-cache'

/** The Web server is the only service this plugin consumes. */
export const inject = ['webServer']

const WORKER_SOURCE = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8')

/** Matches the marker in `service-worker.ts`; TypeScript may add a space before `null`. */
const CONFIG_MARKER = /\/\*\s*dsh-static-cache:config\s*\*\/\s*null/
if (WORKER_SOURCE.split(CONFIG_MARKER).length !== 2) {
  throw new Error('static-cache: service worker source is missing its config marker')
}

/** Minimal request fields the worker route reads. */
interface StaticCacheRequest {
  method?: string
}

/** Minimal response fields the worker route writes. */
interface StaticCacheResponse {
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}

/** Structured index injection row consumed by the Web server. */
interface StaticCacheInjection {
  kind: 'script'
  placement: 'head'
  text: string
}

/** Cordis surface used by this plugin. */
interface StaticCacheContext {
  effect(callback: () => () => void, label: string): void
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler: (request: StaticCacheRequest, response: StaticCacheResponse) => void
    }): () => void
  }
  on(event: 'webserver/index-inject', listener: (table: StaticCacheInjection[]) => void): () => void
}

/**
 * Bake the deployment policy into the served worker text. The page never
 * sends policy back: a same-origin script must not be able to widen the cache.
 * @param config - Resolved configuration.
 * @returns Worker source with its policy in place.
 */
export function workerSource(config: ResolvedStaticCacheConfig): string {
  const policy = {
    prefixes: [...config.prefixes],
    exclude: [...config.exclude],
    concurrency: config.concurrency,
    maxCacheBytes: config.maxCacheBytes,
    maxEntryBytes: config.maxEntryBytes,
    graceMs: config.graceMinutes * 60_000,
    maxAgeMs: config.maxAgeDays * 86_400_000,
    revalidate: config.revalidate,
  }
  return WORKER_SOURCE.replace(CONFIG_MARKER, JSON.stringify(policy))
}

/**
 * Install the worker route and the index registration row.
 * @param ctx - Owning Host context.
 * @param raw - Loader row config; validated here because the plugin carries no schema dependency.
 * @returns Nothing.
 */
export function apply(ctx: StaticCacheContext, raw: unknown): void {
  const config = resolveConfig(raw)
  const script = registerScript(config)
  const worker = workerSource(config)
  const headers: Record<string, string> = Object.freeze({
    'content-type': 'text/javascript; charset=utf-8',
    'cache-control': 'no-cache',
    'service-worker-allowed': config.scope,
    'x-content-type-options': 'nosniff',
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: config.route,
    handler: (req, res) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET, HEAD' })
        res.end()
        return
      }
      res.writeHead(200, headers)
      res.end(req.method === 'HEAD' ? undefined : worker)
    },
  }), 'static-cache: service worker route')

  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'script', placement: 'head', text: script })
  })
}
