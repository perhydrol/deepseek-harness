/** Real HTTP binary delivery through the separately deployed authentication proxy. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import JSZip from 'jszip';
import { apply } from '../src/index.ts';
import { createProxy } from '../../public-auth/src/proxy.ts';
import { initialize } from '../../public-auth/src/auth.ts';

test('authenticated proxy preserves exact file and ZIP bytes, filenames, and login rejection', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-download-proxy-'));
  let app;
  let server;
  let dispose;
  t.after(async () => {
    await app?.close();
    await dispose?.();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const password = 'download-proxy-test-password';
  await initialize(directory, password);
  let handler;
  const bytes = Buffer.from([0, 255, 1, 128, 13, 10]);
  const ctx = {
    connection: { admit: req => req.headers.cookie === 'dsh-auth-test=private' ? { peer: { principal: { kind: 'owner' } } } : { rejection: 401 } },
    sessions: { get: id => id === 'fixture' ? { header: { cwd: '/workspace' } } : undefined },
    sandboxPolicy: { workspaceRoot: '/workspace' },
    workspaceFiles: {
      async list(_scope, path) { return { path, entries: path === '' ? [{ name: '报告.bin', type: 'file' }, { name: 'empty', type: 'directory' }] : [], truncated: false }; },
      async readBytes() { return { data: bytes, eof: true, version: 'v1' }; },
    },
    webServer: { register: route => { handler = route.handler; return () => { handler = undefined; }; } },
    effect: effect => { dispose = effect(); },
  };
  apply(ctx, { maxBytes: 1024, maxEntries: 20, maxConcurrent: 2, chunkBytes: 1024, compressionLevel: 3, maxPreparedDownloads: 2, preparedTtlMs: 300000 });
  server = createServer((req, res) => {
    if (req.url === '/?token=test-only') {
      res.writeHead(303, { Location: './', 'Set-Cookie': 'dsh-auth-test=private; HttpOnly' }); res.end(); return;
    }
    void handler(req, res).catch(() => { res.destroy(); });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const launchUrlFile = join(directory, 'launch-url');
  await writeFile(launchUrlFile, `http://127.0.0.1:${server.address().port}/?token=test-only`);
  app = await createProxy({
    publicOrigin: 'https://download.example.test', launchUrlFile, stateDirectory: directory,
    sessionSeconds: 86400, loginAttempts: 4, loginWindowSeconds: 60,
  });
  const headers = { host: 'download.example.test', origin: 'https://download.example.test', 'content-type': 'application/json' };
  const payload = { sessionId: 'fixture', action: 'download', paths: ['报告.bin'] };
  assert.equal((await app.inject({ method: 'POST', url: '/sidebar-download', headers, payload })).statusCode, 401);
  const login = await app.inject({ method: 'POST', url: '/_auth/login',
    headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ password }).toString() });
  assert.equal(login.statusCode, 303);
  const cookies = login.headers['set-cookie'];
  headers.cookie = String(Array.isArray(cookies) ? cookies.find(value => value.includes('dsh-proxy=')) : cookies).split(';')[0];
  const prepared = await app.inject({ method: 'POST', url: '/sidebar-download', headers, payload });
  assert.equal(prepared.statusCode, 200);
  const ticket = prepared.json().ticket;
  assert.equal((await app.inject({ method: 'GET', url: `/sidebar-download?ticket=${ticket}`, headers: { host: headers.host } })).statusCode, 401);
  const file = await app.inject({ method: 'GET', url: `/sidebar-download?ticket=${ticket}`, headers });
  assert.equal(file.statusCode, 200);
  assert.deepEqual(file.rawPayload, bytes);
  assert.equal(decodeURIComponent(file.headers['x-download-name']), '报告.bin');
  assert.match(file.headers['content-disposition'], /filename\*=UTF-8''/);
  assert.equal(file.headers['cache-control'], 'no-store');
  assert.equal(file.headers['set-cookie'], undefined);
  const reused = await app.inject({ method: 'GET', url: `/sidebar-download?ticket=${ticket}`, headers });
  assert.equal(reused.statusCode, 404, JSON.stringify({ headers: reused.headers, body: reused.body }));
  const zipped = await app.inject({ method: 'POST', url: '/sidebar-download', headers, payload: { ...payload, paths: [''] } });
  const archive = await app.inject({ method: 'GET', url: `/sidebar-download?ticket=${zipped.json().ticket}`, headers });
  assert.equal(archive.statusCode, 200);
  assert.equal(archive.headers['content-type'], 'application/zip');
  const zip = await JSZip.loadAsync(archive.rawPayload);
  assert.deepEqual(await zip.file('报告.bin').async('nodebuffer'), bytes);
  assert.ok(zip.files['empty/'].dir);
});
