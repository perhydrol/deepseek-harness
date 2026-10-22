import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { readFile, access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadSelection, selectionPaths } from '../src/download.ts';

const require = createRequire(import.meta.url);
const limits = { maxBytes: 100, maxEntries: 20, chunkBytes: 3, compressionLevel: 3, temporaryDirectory: tmpdir() };
const signal = new AbortController().signal;
const scope = { sessionId: 'test', workspaceRoot: '/work' };
function files() {
  const data = { 'one.txt': 'hello', 'folder/two.txt': 'world' };
  return {
    async list(_scope, path) {
      if (path === '') return { path, entries: [{ name: 'one.txt', type: 'file' }, { name: 'folder', type: 'directory' }], truncated: false };
      return { path, entries: [{ name: 'two.txt', type: 'file' }, { name: 'empty', type: 'directory' }].filter(() => path === 'folder'), truncated: false };
    },
    async readBytes(_scope, path, { range }) {
      const bytes = Buffer.from(data[path]);
      return { data: bytes.subarray(range.offset, range.offset + range.length), eof: range.offset + range.length >= bytes.length, version: 'v1' };
    },
  };
}
test('rejects unsafe paths and removes descendants of selected directories', () => {
  for (const path of ['../secret', '/etc/passwd', 'x\\y', 'a/../b', 'C:/file']) {
    assert.throws(() => selectionPaths([path]), /invalid-selection/);
  }
  assert.deepEqual(selectionPaths(['folder/two.txt', 'folder', 'folder', 'one.txt']), ['folder', 'one.txt']);
});
test('one file retains its exact bytes and name', async () => {
  const result = await downloadSelection(files(), scope, ['one.txt'], limits, signal);
  assert.equal(result.name, 'one.txt');
  try { assert.equal((await readFile(result.file)).toString(), 'hello'); }
  finally { await result.dispose(); }
  await assert.rejects(access(result.file));
});
test('directory is zipped on the host, including empty directories', async () => {
  const result = await downloadSelection(files(), scope, ['folder', 'folder/two.txt'], limits, signal);
  const JSZip = require('jszip');
  try {
    const zip = await JSZip.loadAsync(await readFile(result.file));
    assert.equal(await zip.file('folder/two.txt').async('string'), 'world');
    assert.ok(zip.files['folder/empty/'].dir);
  } finally { await result.dispose(); }
});
test('multiple files retain workspace-relative archive paths', async () => {
  const result = await downloadSelection(files(), scope, ['one.txt', 'folder/two.txt'], limits, signal);
  try {
    const zip = await require('jszip').loadAsync(await readFile(result.file));
    assert.equal(await zip.file('one.txt').async('string'), 'hello');
    assert.equal(await zip.file('folder/two.txt').async('string'), 'world');
  } finally { await result.dispose(); }
});
test('refuses truncated listings, aliases, unsupported entries, and limits without returning an archive', async () => {
  for (const listing of [
    { path: '', entries: [], truncated: true },
    { path: 'elsewhere', entries: [], truncated: false },
    { path: '', entries: [{ name: 'pipe', type: 'other' }], truncated: false },
  ]) {
    await assert.rejects(downloadSelection({ ...files(), list: async () => listing }, scope, [''], limits, signal));
  }
  await assert.rejects(downloadSelection(files(), scope, ['folder'], { ...limits, maxBytes: 3 }, signal), /size-limit/);
  await assert.rejects(downloadSelection(files(), scope, ['folder'], { ...limits, maxEntries: 1 }, signal), /entry-limit/);
});
test('honors cancellation before reading', async () => {
  await assert.rejects(downloadSelection(files(), scope, ['one.txt'], limits, AbortSignal.abort()), { name: 'AbortError' });
});
test('chunk size is bounded and a version change fails without leaving a partial archive', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-download-test-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const service = files();
  let reads = 0;
  service.readBytes = async (_scope, _path, { range }) => {
    assert.equal(range.length, 3);
    return { data: Buffer.alloc(3), eof: false, version: String(++reads) };
  };
  await assert.rejects(downloadSelection(service, scope, ['folder'], { ...limits, temporaryDirectory: root }, signal), /file-changed/);
  assert.equal(reads, 2);
  assert.deepEqual(await readdir(root), []);
});
test('mid-read cancellation settles the ZIP and removes its temporary file', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-download-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const controller = new AbortController();
  const service = files();
  let reads = 0;
  service.readBytes = async () => {
    if (++reads === 2) controller.abort();
    return { data: Buffer.alloc(3), eof: false, version: 'v1' };
  };
  await assert.rejects(downloadSelection(service, scope, ['folder'], { ...limits, temporaryDirectory: root }, controller.signal));
  assert.equal(reads, 2);
  assert.deepEqual(await readdir(root), []);
});
test('large input is read in bounded windows while the event loop continues running', async t => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-download-large-'));
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const service = files();
  const size = 16 * 1024 * 1024;
  const chunkBytes = 256 * 1024;
  let calls = 0;
  let turns = 0;
  let stopped = false;
  let handle;
  const tick = () => { if (!stopped) { turns++; handle = setImmediate(tick); } };
  tick();
  service.readBytes = async (_scope, _path, { range }) => {
    assert.equal(range.length, chunkBytes); calls++;
    return { data: Buffer.alloc(Math.min(chunkBytes, size - range.offset), 65), eof: range.offset + chunkBytes >= size, version: 'v1' };
  };
  let result;
  try {
    result = await downloadSelection(service, scope, ['one.txt', 'folder/empty'], { ...limits, maxBytes: size, chunkBytes, temporaryDirectory: root }, signal);
    assert.equal(calls, size / chunkBytes);
    assert.ok(turns > 1);
    const zip = await require('jszip').loadAsync(await readFile(result.file));
    assert.equal((await zip.file('one.txt').async('uint8array')).length, size);
  } finally { stopped = true; clearImmediate(handle); await result?.dispose(); }
  assert.deepEqual(await readdir(root), []);
});
