/** Host-owned independent authentication pages and a minimal authenticated bootstrap flag. */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@hydrogen/dsh-browser-auth'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Service prerequisites; this page plugin only belongs to the single-user composition. */
export const inject = ['webServer', 'browserAuth']

/**
 * Render a document without the application manifest, injections or plugin module loader.
 * *
 * @param mode - fixed page purpose.
 * *
 * @param mountPath - validated external mount path.
 * *
 * @returns independent HTML with only authentication assets.
 */
export function renderAuthPage(mode: 'login' | 'security', mountPath: string): string {
  return '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title></title><link rel="stylesheet" href="./client.css"></head><body>'
    + '<main id="auth-root" data-auth-mode="' + mode + '" data-auth-mount="' + encodeURIComponent(mountPath) + '"></main>'
    + '<script type="module" src="./client.js"></script></body></html>'
}

/**
 * Load built standalone assets before publishing any page routes.
 * *
 * @param ctx - authentication and required listener services.
 * *
 * @returns after exact route registrations and private bootstrap metadata install.
 */
export async function apply(ctx: Context): Promise<void> {
  const policy = ctx.browserAuth.trustPolicy
  if (policy.mode !== 'single-user' || !ctx.webServer.requiresRequestGate) {
    throw new Error('browser-auth pages require single-user authentication and a required listener gate.')
  }
  const [javascript, base, palette, page] = await Promise.all([
    readFile(new URL('./login.js', import.meta.url)), readFile(new URL('./styles/base.css', import.meta.url)),
    readFile(new URL('./styles/design-platform.css', import.meta.url)), readFile(new URL('./styles/page.css', import.meta.url)),
  ])
  const assets = [
    { path: '/auth/login', type: 'text/html; charset=utf-8', body: Buffer.from(renderAuthPage('login', policy.mountPath)) },
    { path: '/auth/security', type: 'text/html; charset=utf-8', body: Buffer.from(renderAuthPage('security', policy.mountPath)) },
    { path: '/auth/client.js', type: 'text/javascript; charset=utf-8', body: javascript },
    { path: '/auth/client.css', type: 'text/css; charset=utf-8', body: Buffer.concat([base, palette, page]) },
  ]
  for (const asset of assets) ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: asset.path,
    handler: (request, response) => {
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }); response.end(); return
      }
      response.writeHead(200, {
        'content-type': asset.type, 'content-length': String(asset.body.length), 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
        ...(asset.type.startsWith('text/html') ? { 'content-security-policy':
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" } : {}),
      })
      response.end(request.method === 'HEAD' ? undefined : asset.body)
    },
  }), 'browser-auth pages: ' + asset.path)
  ctx.on('webserver/index-inject', (table) => {
    table.push({ kind: 'global', name: '__DSH_BROWSER_AUTH__', value: { mountPath: policy.mountPath } })
  })
}
