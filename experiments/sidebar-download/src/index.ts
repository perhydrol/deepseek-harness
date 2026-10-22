/** Authenticated owner-only HTTP downloads; files remain behind the composed filesystem. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { tmpdir } from 'node:os';
import { isAbsolute } from 'node:path';
import { directory, DownloadError, downloadSelection, selectionPaths } from './download.ts';
import type { Files } from './download.ts';

/** Required services; the plugin cannot serve files without authentication. */
export const inject = ['webServer', 'connection', 'workspaceFiles', 'sessions', 'sandboxPolicy'];
/** Deployment caps, supplied by the bundle patch. */
export interface Config {
  maxBytes: number; maxEntries: number; maxConcurrent: number;
  chunkBytes: number; compressionLevel: number; maxPreparedDownloads: number; preparedTtlMs: number;
  temporaryDirectory?: string;
}
/** Structural host APIs used by this standalone plugin. */
export interface Host {
  connection: { admit(req: IncomingMessage): { rejection: number } | { peer: { principal: { kind: string } } } };
  workspaceFiles: Files;
  sessions: { get(id: string): { header: { cwd?: string } } | undefined };
  sessionPersistence?: { stat(id: string): Promise<{ header: { cwd?: string } } | undefined> };
  sandboxPolicy: { workspaceRoot: string };
  webServer: { register(route: { kind: 'exact'; path: string; handler(req: IncomingMessage, res: ServerResponse): Promise<void> }): () => void };
  effect(effect: () => () => void | Promise<void>): void;
}
/**
 * Register an authenticated endpoint; unloading aborts and awaits all active requests.
 * @param ctx - Host services with a composed filesystem and login admission.
 * @param config - Positive aggregate byte, entry, and concurrency caps.
 */
export function apply(ctx: Host, config: Config): void {
  for (const key of ['maxBytes', 'maxEntries', 'maxConcurrent', 'chunkBytes', 'maxPreparedDownloads', 'preparedTtlMs'] as const) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`sidebar-download: ${key} must be a positive safe integer`);
  }
  if (!Number.isInteger(config.compressionLevel) || config.compressionLevel < 0 || config.compressionLevel > 9) throw new Error('sidebar-download: compressionLevel must be 0-9');
  if (config.preparedTtlMs > 2147483647) throw new Error('sidebar-download: preparedTtlMs exceeds the timer range');
  const limits = { ...config, temporaryDirectory: config.temporaryDirectory ?? tmpdir() };
  if (!isAbsolute(limits.temporaryDirectory)) throw new Error('sidebar-download: temporaryDirectory must be absolute');
  const active = new Map<AbortController, Promise<void>>();
  type Prepared = Awaited<ReturnType<typeof downloadSelection>>;
  const prepared = new Map<string, { result: Prepared; timer: NodeJS.Timeout }>();
  const cleaning = new Set<Promise<void>>();
  let preparing = 0;
  const release = async (ticket: string) => {
    const item = prepared.get(ticket);
    if (!item) return;
    prepared.delete(ticket); clearTimeout(item.timer);
    await item.result.dispose();
  };
  ctx.effect(() => {
    const unregister = ctx.webServer.register({
      kind: 'exact', path: '/sidebar-download',
      async handler(req, res) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        const admission = ctx.connection.admit(req);
        if ('rejection' in admission) { res.writeHead(admission.rejection); res.end(); return; }
        if (admission.peer.principal.kind !== 'owner') { res.writeHead(403); res.end(); return; }
        if (req.method !== 'POST' && req.method !== 'GET') { res.writeHead(405, { Allow: 'GET, POST' }); res.end(); return; }
        if (req.method === 'POST' && req.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') { res.writeHead(415); res.end(); return; }
        if (active.size >= config.maxConcurrent) { res.writeHead(429); res.end(); return; }
        const controller = new AbortController();
        const cancel = () => { if (!res.writableFinished) controller.abort(); };
        const stop = () => { req.destroy(); res.destroy(); };
        controller.signal.addEventListener('abort', stop, { once: true });
        res.on('close', cancel);
        const task = run(req, res, controller.signal);
        active.set(controller, task);
        try { await task; } finally {
          active.delete(controller); res.off('close', cancel);
          controller.signal.removeEventListener('abort', stop);
        }
      },
    });
    return async () => {
      unregister();
      for (const controller of active.keys()) controller.abort();
      await Promise.allSettled(active.values());
      const released = await Promise.allSettled([...prepared.keys()].map(release));
      await Promise.allSettled(cleaning);
      const failed = released.filter(result => result.status === 'rejected');
      if (failed.length) throw new AggregateError(failed.map(result => result.reason), 'Download temporary-file cleanup failed');
    };
  });
  async function run(req: IncomingMessage, res: ServerResponse, signal: AbortSignal): Promise<void> {
    try {
      if (req.method === 'GET') {
        const ticket = new URL(req.url!, 'http://localhost').searchParams.get('ticket') ?? '';
        const item = prepared.get(ticket);
        if (!item) throw new DownloadError('expired', 404);
        prepared.delete(ticket); clearTimeout(item.timer);
        try {
          const result = item.result;
          res.writeHead(200, {
            'Content-Type': result.type, 'Content-Length': result.size,
            'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(result.name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16)}`)}`,
            'X-Download-Name': encodeURIComponent(result.name),
          });
          await pipeline(createReadStream(result.file), res, { signal });
        } finally { await item.result.dispose(); }
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        signal.throwIfAborted();
        size += chunk.length;
        if (size > 65536) throw new DownloadError('invalid-selection', 413);
        chunks.push(chunk);
      }
      let body: { sessionId?: unknown; action?: unknown; paths?: unknown; path?: unknown; ticket?: unknown };
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
      catch (error) { throw new DownloadError('invalid-selection', 400, { cause: error }); }
      if (!body || typeof body.sessionId !== 'string' || body.sessionId.length === 0) throw new DownloadError('invalid-selection');
      const header = ctx.sessions.get(body.sessionId)?.header ?? (await ctx.sessionPersistence?.stat(body.sessionId))?.header;
      if (!header) throw new DownloadError('not-found', 404);
      const scope = { sessionId: body.sessionId, workspaceRoot: header.cwd ?? ctx.sandboxPolicy.workspaceRoot };
      if (body.action === 'list') {
        const path = selectionPaths([body.path])[0]!;
        const result = await directory(ctx.workspaceFiles, scope, path, signal);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } else if (body.action === 'download') {
        if (prepared.size + preparing >= config.maxPreparedDownloads) throw new DownloadError('busy', 429);
        preparing++;
        try {
          const result = await downloadSelection(ctx.workspaceFiles, scope, body.paths, limits, signal);
          if (signal.aborted) { await result.dispose(); signal.throwIfAborted(); }
          const ticket = randomUUID();
          const timer = setTimeout(() => {
            const task = release(ticket).catch(error => { console.error('Download temporary-file cleanup failed', error); });
            cleaning.add(task); void task.finally(() => cleaning.delete(task));
          }, config.preparedTtlMs);
          timer.unref(); prepared.set(ticket, { result, timer });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ticket, name: result.name }));
        } finally { preparing--; }
      } else if (body.action === 'discard' && typeof body.ticket === 'string') {
        await release(body.ticket);
        res.writeHead(204); res.end();
      } else throw new DownloadError('invalid-selection');
    } catch (error) {
      if (res.destroyed) return;
      if (res.headersSent) { res.destroy(); return; }
      const expected = error instanceof DownloadError;
      res.writeHead(expected ? error.status : 500, { 'X-Download-Error': expected ? error.code : 'read-failed' });
      res.end();
    }
  }
}
