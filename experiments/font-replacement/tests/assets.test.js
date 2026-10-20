/** HTTP asset access and teardown checks for the font bundle. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { test } from 'node:test';
import { createHash } from 'node:crypto';

test('serves bundled fonts, rejects other paths, and unregisters on disposal', async () => {
  const { apply } = await import('../index.js');
  let route;
  let dispose;
  apply({
    webServer: { register(value) { route = value; return () => { route = undefined; }; } },
    effect(setup) { dispose = setup(); },
  });
  const server = createServer((req, res) => {
    if (!route) { res.writeHead(404); res.end(); return; }
    void route.handler(req, res).catch(() => { res.writeHead(500); res.end(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const css = await fetch(`${base}/font-replacement/fonts.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    assert.equal(css.headers.get('cache-control'), 'no-cache');
    const tag = css.headers.get('etag');
    assert.ok(tag);
    const cachedCss = await fetch(`${base}/font-replacement/fonts.css`, { headers: { 'If-None-Match': tag } });
    assert.equal(cachedCss.status, 304);
    assert.equal(await cachedCss.text(), '');
    const body = await css.text();
    assert.match(body, /HarmonyOS Sans SC/);
    assert.match(body, /Maple Mono NL NF CN/);
    assert.doesNotMatch(body, /url\("\/fonts\//);
    const urls = [...body.matchAll(/url\("([^"]+)"\)/g)].map(match => match[1]);
    assert.equal(urls.length, 1001);
    for (const url of [urls[0], urls.at(-1)]) {
      const font = await fetch(`${base}${url}`);
      assert.equal(font.status, 200);
      assert.equal(font.headers.get('content-type'), 'font/woff2');
      assert.equal(font.headers.get('cache-control'), 'public, max-age=31536000, immutable');
      const bytes = Buffer.from(await font.arrayBuffer());
      assert.equal(bytes.subarray(0, 4).toString(), 'wOF2');
      assert.equal(url, `/font-replacement/${createHash('sha256').update(bytes).digest('hex')}.woff2`);
    }
    for (const path of ['package.json', '../package.json', '%2e%2e%2fpackage.json', 'maple-mono/missing.woff2']) {
      assert.equal((await fetch(`${base}/font-replacement/${path}`)).status, 404);
    }
    assert.equal((await fetch(`${base}/font-replacement/fonts.css`, { method: 'POST' })).status, 405);
    const head = await fetch(`${base}/font-replacement/fonts.css`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    dispose();
    assert.equal((await fetch(`${base}/font-replacement/fonts.css`)).status, 404);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
