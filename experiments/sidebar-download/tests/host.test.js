/** Exercise the actual HTTP handler without binding a host port. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { apply } from '../src/index.ts';

function fixture(admission = { peer: { principal: { kind: 'owner' } } }) {
  let handler;
  let dispose;
  let called = 0;
  const ctx = {
    connection: { admit: () => admission },
    sessions: { get: id => id === 'valid' ? { header: { cwd: '/work' } } : undefined },
    sandboxPolicy: { workspaceRoot: '/fallback' },
    workspaceFiles: {
      async list(scope, path) {
        called++;
        assert.deepEqual(scope, { sessionId: 'valid', workspaceRoot: '/work' });
        return { path, entries: [{ name: '中文.txt', type: 'file' }], truncated: false };
      },
      async readBytes() { return { data: Buffer.from('exact bytes'), eof: true, version: 'v1' }; },
    },
    webServer: { register: route => { handler = route.handler; return () => { handler = undefined; }; } },
    effect: fn => { dispose = fn(); },
  };
  apply(ctx, { maxBytes: 1000, maxEntries: 20, maxConcurrent: 1, chunkBytes: 1000, compressionLevel: 3, maxPreparedDownloads: 2, preparedTtlMs: 300000 });
  return {
    ctx, get called() { return called; }, close: () => dispose(),
    async call(body, { method = 'POST', type = 'application/json' } = {}) {
      const req = Readable.from([Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]);
      req.method = method; req.headers = { 'content-type': type };
      const res = new EventEmitter();
      const headers = {};
      res.setHeader = (key, value) => { headers[key] = value; };
      res.writeHead = (status, extra) => { res.status = status; Object.assign(headers, extra); };
      res.end = data => { res.data = data; };
      res.destroy = () => { res.destroyed = true; res.emit('close'); };
      await handler(req, res);
      return { status: res.status, headers, data: res.data };
    },
  };
}
test('unauthenticated and shared callers never resolve a workspace', async () => {
  for (const admission of [{ rejection: 401 }, { peer: { principal: { kind: 'shared' } } }]) {
    const f = fixture(admission);
    try { assert.ok([401, 403].includes((await f.call({ sessionId: 'valid', action: 'list', path: '' })).status)); assert.equal(f.called, 0); }
    finally { await f.close(); }
  }
});
test('valid owner lists the session workspace and downloads exact Unicode-named bytes', async () => {
  const f = fixture();
  try {
    const listed = await f.call({ sessionId: 'valid', action: 'list', path: '' });
    assert.equal(JSON.parse(listed.data).entries[0].name, '中文.txt');
    const result = await f.call({ sessionId: 'valid', action: 'download', paths: ['中文.txt'] });
    assert.equal(result.status, 200); assert.equal(JSON.parse(result.data).name, '中文.txt');
    assert.equal(typeof JSON.parse(result.data).ticket, 'string');
    assert.equal(result.headers['Cache-Control'], 'no-store');
  } finally { await f.close(); }
});
test('refuses malformed bodies, unknown sessions, traversal, wrong methods and media types', async () => {
  const f = fixture();
  try {
    for (const body of ['{', 'null', { action: 'list' }, { sessionId: 'gone', action: 'list', path: '' },
      { sessionId: 'valid', action: 'download', paths: ['../private'] }, { sessionId: 'valid', action: 'unknown' }]) {
      assert.ok((await f.call(body)).status >= 400);
    }
    assert.equal((await f.call({}, { method: 'DELETE' })).status, 405);
    assert.equal((await f.call({}, { type: 'text/plain' })).status, 415);
    assert.equal((await f.call('x'.repeat(65537))).status, 413);
  } finally { await f.close(); }
});
test('misconfiguration fails activation', () => {
  assert.throws(() => apply({}, { maxBytes: 0, maxEntries: 1, maxConcurrent: 1 }), /maxBytes/);
});
test('concurrency is bounded and disposal cancels and awaits an active read', async () => {
  const f = fixture();
  let started;
  const entered = new Promise(resolve => { started = resolve; });
  let aborted = false;
  f.ctx.workspaceFiles.list = async (_scope, _path, signal) => {
    started();
    await new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      aborted = true; reject(signal.reason);
    }, { once: true }));
  };
  const running = f.call({ sessionId: 'valid', action: 'list', path: '' });
  await entered;
  assert.equal((await f.call({ sessionId: 'valid', action: 'list', path: '' })).status, 429);
  await f.close();
  await running;
  assert.equal(aborted, true);
});
test('discard frees prepared capacity across repeated prepare-close cycles', async () => {
  const f = fixture();
  try {
    for (let index = 0; index < 6; index++) {
      const prepared = await f.call({ sessionId: 'valid', action: 'download', paths: ['中文.txt'] });
      assert.equal(prepared.status, 200);
      const ticket = JSON.parse(prepared.data).ticket;
      assert.equal((await f.call({ sessionId: 'valid', action: 'discard', ticket })).status, 204);
    }
    for (let index = 0; index < 2; index++) assert.equal((await f.call({ sessionId: 'valid', action: 'download', paths: ['中文.txt'] })).status, 200);
    assert.equal((await f.call({ sessionId: 'valid', action: 'download', paths: ['中文.txt'] })).status, 429);
  } finally { await f.close(); }
});
