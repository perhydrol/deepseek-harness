/** Bounded, workspace-relative downloads over the composed file service. */
import { ZipArchive } from 'archiver';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import { once } from 'node:events';

/** Deployment limits for one complete download. */
export interface Limits { maxBytes: number; maxEntries: number; chunkBytes: number; compressionLevel: number; temporaryDirectory: string }
/** Session header used by the existing workspace file service. */
export interface Scope { sessionId: string; workspaceRoot: string }
/** Entry metadata returned by the workspace listing. */
export interface Entry { name: string; type: 'file' | 'directory' | 'other'; size?: number }
/** File-service methods used without bypassing its read policy or caps. */
export interface Files {
  list(scope: Scope, path: string, signal: AbortSignal): Promise<{ path: string; entries: readonly Entry[]; truncated: boolean }>;
  readBytes(scope: Scope, path: string, options: { range: { offset: number; length: number } }, signal: AbortSignal): Promise<{ data: Uint8Array; eof: boolean; version: string }>;
}
/** Expected refusal; code is translated by the browser. */
export class DownloadError extends Error {
  constructor(readonly code: string, readonly status = 400, options?: ErrorOptions) { super(code, options); }
}
/**
 * Validate portable relative names, deduplicate, and remove covered descendants.
 * @param input - Untrusted JSON selection; empty path selects the workspace.
 * @returns Stable paths with no absolute paths or traversal components.
 */
export function selectionPaths(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.some(path => typeof path !== 'string'
    || /[\\:]/u.test(path) || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || (path !== '' && path.split('/').some(part => part === '' || part === '.' || part === '..')))) {
    throw new DownloadError('invalid-selection');
  }
  const paths = [...new Set<string>(input)].sort();
  return paths.filter(path => !paths.some(parent => parent !== path && (parent === '' || path.startsWith(`${parent}/`))));
}
/**
 * Read a complete directory without silently omitting capped entries or aliases.
 * @param files - Composed workspace file service.
 * @param scope - Header-derived workspace scope.
 * @param path - Validated relative directory.
 * @param signal - Request cancellation.
 * @returns Complete listing; aliases and truncated listings are refused.
 */
export async function directory(files: Files, scope: Scope, path: string, signal: AbortSignal) {
  signal.throwIfAborted();
  const listing = await files.list(scope, path === '' ? '.' : path, signal);
  if (listing.truncated) throw new DownloadError('listing-truncated', 413);
  if (listing.path !== path) throw new DownloadError('unsupported-entry');
  for (const entry of listing.entries) {
    if (entry.name === '' || entry.name.includes('/') || selectionPaths([entry.name])[0] !== entry.name) {
      throw new DownloadError('unsupported-entry');
    }
  }
  return listing;
}
/**
 * Prepare exact single-file bytes or a ZIP before any response body is sent.
 * @param files - Composed file reader with its own file-size and symlink checks.
 * @param scope - Header-derived workspace scope.
 * @param input - Selected relative paths.
 * @param limits - Aggregate uncompressed byte and entry limits.
 * @param signal - Cancellation stops reads and ZIP generation.
 * @returns Prepared private file and its cleanup; failures remove partial output before rejecting.
 */
export async function downloadSelection(files: Files, scope: Scope, input: unknown, limits: Limits, signal: AbortSignal) {
  const paths = selectionPaths(input);
  const pending: { path: string; type: Entry['type'] }[] = [];
  const levels = new Map<string, Awaited<ReturnType<typeof directory>>>();
  const list = async (path: string) => {
    let level = levels.get(path);
    if (!level) { level = await directory(files, scope, path, signal); levels.set(path, level); }
    return level;
  };
  for (const path of paths) {
    signal.throwIfAborted();
    if (path === '') { pending.push({ path, type: 'directory' }); continue; }
    const parts = path.split('/');
    const name = parts.pop();
    const entry = (await list(parts.join('/'))).entries.find(entry => entry.name === name);
    if (!entry) throw new DownloadError('not-found', 404);
    pending.push({ path, type: entry.type });
  }
  const single = pending.length === 1 && pending[0]?.type === 'file';
  const plan: { path: string; type: 'file' | 'directory' }[] = [];
  let entries = 0;
  const seen = new Set<string>();
  while (pending.length) {
    signal.throwIfAborted();
    const item = pending.pop()!;
    if (seen.has(item.path)) continue;
    seen.add(item.path);
    if (++entries > limits.maxEntries) throw new DownloadError('entry-limit', 413);
    if (item.type === 'directory') {
      if (item.path) plan.push({ path: item.path, type: 'directory' });
      const level = await list(item.path);
      if (pending.length + level.entries.length + entries > limits.maxEntries) throw new DownloadError('entry-limit', 413);
      for (const child of level.entries) pending.push({ path: item.path ? `${item.path}/${child.name}` : child.name, type: child.type });
    } else if (item.type === 'file') {
      plan.push({ path: item.path, type: 'file' });
    } else throw new DownloadError('unsupported-entry');
  }
  const directoryPath = await mkdtemp(join(limits.temporaryDirectory, 'dsh-download-'));
  const file = join(directoryPath, 'payload');
  const dispose = () => rm(directoryPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const lifetime = new AbortController();
  const cancel = () => lifetime.abort(signal.reason);
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let totalBytes = 0;
  let source: Readable | undefined;
  let archive: ZipArchive | undefined;
  let failure: Error | undefined;
  let writing: Promise<Error | undefined> | undefined;
  async function* chunks(path: string) {
    let offset = 0;
    let version: string | undefined;
    for (;;) {
      lifetime.signal.throwIfAborted();
      const result = await files.readBytes(scope, path, { range: { offset, length: limits.chunkBytes } }, lifetime.signal);
      lifetime.signal.throwIfAborted();
      if (version !== undefined && version !== result.version) throw new DownloadError('file-changed', 409);
      version = result.version;
      totalBytes += result.data.byteLength;
      if (totalBytes > limits.maxBytes) throw new DownloadError('size-limit', 413);
      yield result.data;
      offset += result.data.byteLength;
      if (result.eof) return;
      if (result.data.byteLength === 0) throw new DownloadError('incomplete-read');
    }
  }
  try {
    const output = createWriteStream(file, { flags: 'wx', mode: 0o600 });
    if (single) {
      source = Readable.from(chunks(plan[0]!.path), { objectMode: false });
      await pipeline(source, output, { signal: lifetime.signal });
    } else {
      archive = new ZipArchive({ zlib: { level: limits.compressionLevel } });
      const zip = archive;
      zip.on('warning', error => zip.destroy(error));
      writing = pipeline(zip, output, { signal: lifetime.signal }).then(() => undefined, error => {
        failure ??= error; lifetime.abort(error); return error;
      });
      for (const item of plan) {
        lifetime.signal.throwIfAborted();
        const appended = once(zip, 'entry', { signal: lifetime.signal });
        if (item.type === 'directory') zip.append('', { name: `${item.path}/`, type: 'directory' });
        else {
          source = Readable.from(chunks(item.path), { objectMode: false });
          source.on('error', error => { failure ??= error; zip.destroy(error); });
          zip.append(source, { name: item.path });
        }
        await appended;
        if (source) { await finished(source); source = undefined; }
      }
      void zip.finalize().catch(error => zip.destroy(error));
      const error = await writing;
      if (error) throw error;
    }
    signal.throwIfAborted();
    const name = single ? paths[0]!.split('/').pop()! : paths.length === 1 && paths[0] ? `${paths[0].split('/').pop()}.zip` : 'files.zip';
    return { name, type: single ? 'application/octet-stream' : 'application/zip', file, size: (await stat(file)).size, dispose };
  } catch (error) {
    lifetime.abort(error);
    source?.destroy(); archive?.abort(); archive?.destroy();
    if (source) await finished(source).catch(() => { /* The original operation error is reported below. */ });
    await writing;
    await dispose();
    throw failure ?? error;
  } finally { signal.removeEventListener('abort', cancel); }
}
