/** Serve only the bundle's font stylesheet and its declared WOFF2 fragments. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

/** Required Host service for same-origin font delivery. */
export const inject = ['webServer'];

/**
 * Register font assets until this plugin is disposed; missing fragments fail activation.
 * @param {object} ctx - Cordis context with the Web server and effect ownership.
 */
export function apply(ctx) {
  const source = readFileSync(new URL('./fonts/fonts.css', import.meta.url), 'utf8');
  const assets = new Map();
  const css = source.replace(/url\("(\/font-replacement\/(?:maple-mono|harmony-sans-sc)\/[a-f0-9]+\.woff2)"\)/g, (_match, path) => {
    const file = new URL(`./fonts/${path.slice('/font-replacement/'.length)}`, import.meta.url);
    const bytes = readFileSync(file);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const url = `/font-replacement/${hash}.woff2`;
    assets.set(url, bytes);
    return `url("${url}")`;
  });
  if (assets.size === 0) throw new Error('Font stylesheet declares no bundled WOFF2 fragments');
  const etag = `"${createHash('sha256').update(css).digest('hex')}"`;
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/font-replacement',
    async handler(req, res) {
      const path = new URL(req.url, 'http://localhost').pathname;
      const stylesheet = path === '/font-replacement/fonts.css';
      const font = assets.get(path);
      if (!stylesheet && !font) { res.writeHead(404); res.end(); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return;
      }
      if (stylesheet && req.headers['if-none-match']?.split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' }); res.end(); return;
      }
      const body = stylesheet ? Buffer.from(css) : font;
      res.writeHead(200, {
        'Content-Type': stylesheet ? 'text/css; charset=utf-8' : 'font/woff2',
        'Content-Length': body.length,
        'Cache-Control': stylesheet ? 'no-cache' : 'public, max-age=31536000, immutable',
        ...(stylesheet ? { ETag: etag } : {}),
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    },
  }));
}
