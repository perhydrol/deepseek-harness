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
import { resolveConfig } from './config.js'
import { registerScript } from './register.js'

/** Stable Cordis plugin name. */
export const name = 'static-cache'

/** The Web server is the only service this plugin consumes. */
export const inject = ['webServer']

const WORKER_SOURCE = readFileSync(new URL('./service-worker.js', import.meta.url), 'utf8')

/** Must match the marker in `service-worker.js` exactly once. */
const CONFIG_MARKER = '/* dsh-static-cache:config */null'
if (WORKER_SOURCE.split(CONFIG_MARKER).length !== 2) {
  throw new Error('static-cache: service worker source is missing its config marker')
}

/**
 * Bake the deployment policy into the served worker text. The page never
 * sends policy back: a same-origin script must not be able to widen the cache.
 * @param {import('./config.js').ResolvedStaticCacheConfig} config Resolved configuration.
 * @returns {string} Worker source with its policy in place.
 */
export function workerSource(config) {
  const policy = {
    prefixes: [...config.prefixes],
    exclude: [...config.exclude],
    concurrency: config.concurrency,
    maxCacheBytes: config.maxCacheBytes,
    maxEntryBytes: config.maxEntryBytes,
    graceMs: config.graceMinutes * 60_000,
    maxAgeMs: config.maxAgeDays * 86_400_000,
  }
  return WORKER_SOURCE.replace(CONFIG_MARKER, JSON.stringify(policy))
}

/**
 * Install the worker route and the index registration row.
 * @param {import('@deepseek-ai/cordis').Context} ctx Owning Host context.
 * @param {unknown} raw Loader row config; validated here because the plugin carries no schema dependency.
 * @returns {void}
 */
export function apply(ctx, raw) {
  const config = resolveConfig(raw)
  const script = registerScript(config)
  const worker = workerSource(config)
  const headers = Object.freeze({
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
