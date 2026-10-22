import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { finished, pipeline } from "node:stream/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { ZipArchive } from "archiver";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { once } from "node:events";
//#region experiments/sidebar-download/src/download.ts
/** Bounded, workspace-relative downloads over the composed file service. */
/** Expected refusal; code is translated by the browser. */
var DownloadError = class extends Error {
	code;
	status;
	constructor(code, status = 400, options) {
		super(code, options);
		this.code = code;
		this.status = status;
	}
};
/**
* Validate portable relative names, deduplicate, and remove covered descendants.
* @param input - Untrusted JSON selection; empty path selects the workspace.
* @returns Stable paths with no absolute paths or traversal components.
*/
function selectionPaths(input) {
	if (!Array.isArray(input) || input.length === 0 || input.some((path) => typeof path !== "string" || /[\\:]/u.test(path) || [...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || path !== "" && path.split("/").some((part) => part === "" || part === "." || part === ".."))) throw new DownloadError("invalid-selection");
	const paths = [...new Set(input)].sort();
	return paths.filter((path) => !paths.some((parent) => parent !== path && (parent === "" || path.startsWith(`${parent}/`))));
}
/**
* Read a complete directory without silently omitting capped entries or aliases.
* @param files - Composed workspace file service.
* @param scope - Header-derived workspace scope.
* @param path - Validated relative directory.
* @param signal - Request cancellation.
* @returns Complete listing; aliases and truncated listings are refused.
*/
async function directory(files, scope, path, signal) {
	signal.throwIfAborted();
	const listing = await files.list(scope, path === "" ? "." : path, signal);
	if (listing.truncated) throw new DownloadError("listing-truncated", 413);
	if (listing.path !== path) throw new DownloadError("unsupported-entry");
	for (const entry of listing.entries) if (entry.name === "" || entry.name.includes("/") || selectionPaths([entry.name])[0] !== entry.name) throw new DownloadError("unsupported-entry");
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
async function downloadSelection(files, scope, input, limits, signal) {
	const paths = selectionPaths(input);
	const pending = [];
	const levels = /* @__PURE__ */ new Map();
	const list = async (path) => {
		let level = levels.get(path);
		if (!level) {
			level = await directory(files, scope, path, signal);
			levels.set(path, level);
		}
		return level;
	};
	for (const path of paths) {
		signal.throwIfAborted();
		if (path === "") {
			pending.push({
				path,
				type: "directory"
			});
			continue;
		}
		const parts = path.split("/");
		const name = parts.pop();
		const entry = (await list(parts.join("/"))).entries.find((entry) => entry.name === name);
		if (!entry) throw new DownloadError("not-found", 404);
		pending.push({
			path,
			type: entry.type
		});
	}
	const single = pending.length === 1 && pending[0]?.type === "file";
	const plan = [];
	let entries = 0;
	const seen = /* @__PURE__ */ new Set();
	while (pending.length) {
		signal.throwIfAborted();
		const item = pending.pop();
		if (seen.has(item.path)) continue;
		seen.add(item.path);
		if (++entries > limits.maxEntries) throw new DownloadError("entry-limit", 413);
		if (item.type === "directory") {
			if (item.path) plan.push({
				path: item.path,
				type: "directory"
			});
			const level = await list(item.path);
			if (pending.length + level.entries.length + entries > limits.maxEntries) throw new DownloadError("entry-limit", 413);
			for (const child of level.entries) pending.push({
				path: item.path ? `${item.path}/${child.name}` : child.name,
				type: child.type
			});
		} else if (item.type === "file") plan.push({
			path: item.path,
			type: "file"
		});
		else throw new DownloadError("unsupported-entry");
	}
	const directoryPath = await mkdtemp(join(limits.temporaryDirectory, "dsh-download-"));
	const file = join(directoryPath, "payload");
	const dispose = () => rm(directoryPath, {
		recursive: true,
		force: true,
		maxRetries: 5,
		retryDelay: 100
	});
	const lifetime = new AbortController();
	const cancel = () => lifetime.abort(signal.reason);
	signal.addEventListener("abort", cancel, { once: true });
	if (signal.aborted) cancel();
	let totalBytes = 0;
	let source;
	let archive;
	let failure;
	let writing;
	async function* chunks(path) {
		let offset = 0;
		let version;
		for (;;) {
			lifetime.signal.throwIfAborted();
			const result = await files.readBytes(scope, path, { range: {
				offset,
				length: limits.chunkBytes
			} }, lifetime.signal);
			lifetime.signal.throwIfAborted();
			if (version !== void 0 && version !== result.version) throw new DownloadError("file-changed", 409);
			version = result.version;
			totalBytes += result.data.byteLength;
			if (totalBytes > limits.maxBytes) throw new DownloadError("size-limit", 413);
			yield result.data;
			offset += result.data.byteLength;
			if (result.eof) return;
			if (result.data.byteLength === 0) throw new DownloadError("incomplete-read");
		}
	}
	try {
		const output = createWriteStream(file, {
			flags: "wx",
			mode: 384
		});
		if (single) {
			source = Readable.from(chunks(plan[0].path), { objectMode: false });
			await pipeline(source, output, { signal: lifetime.signal });
		} else {
			archive = new ZipArchive({ zlib: { level: limits.compressionLevel } });
			const zip = archive;
			zip.on("warning", (error) => zip.destroy(error));
			writing = pipeline(zip, output, { signal: lifetime.signal }).then(() => void 0, (error) => {
				failure ??= error;
				lifetime.abort(error);
				return error;
			});
			for (const item of plan) {
				lifetime.signal.throwIfAborted();
				const appended = once(zip, "entry", { signal: lifetime.signal });
				if (item.type === "directory") zip.append("", {
					name: `${item.path}/`,
					type: "directory"
				});
				else {
					source = Readable.from(chunks(item.path), { objectMode: false });
					source.on("error", (error) => {
						failure ??= error;
						zip.destroy(error);
					});
					zip.append(source, { name: item.path });
				}
				await appended;
				if (source) {
					await finished(source);
					source = void 0;
				}
			}
			zip.finalize().catch((error) => zip.destroy(error));
			const error = await writing;
			if (error) throw error;
		}
		signal.throwIfAborted();
		return {
			name: single ? paths[0].split("/").pop() : paths.length === 1 && paths[0] ? `${paths[0].split("/").pop()}.zip` : "files.zip",
			type: single ? "application/octet-stream" : "application/zip",
			file,
			size: (await stat(file)).size,
			dispose
		};
	} catch (error) {
		lifetime.abort(error);
		source?.destroy();
		archive?.abort();
		archive?.destroy();
		if (source) await finished(source).catch(() => {});
		await writing;
		await dispose();
		throw failure ?? error;
	} finally {
		signal.removeEventListener("abort", cancel);
	}
}
//#endregion
//#region experiments/sidebar-download/src/index.ts
/** Required services; the plugin cannot serve files without authentication. */
const inject = [
	"webServer",
	"connection",
	"workspaceFiles",
	"sessions",
	"sandboxPolicy"
];
/**
* Register an authenticated endpoint; unloading aborts and awaits all active requests.
* @param ctx - Host services with a composed filesystem and login admission.
* @param config - Positive aggregate byte, entry, and concurrency caps.
*/
function apply(ctx, config) {
	for (const key of [
		"maxBytes",
		"maxEntries",
		"maxConcurrent",
		"chunkBytes",
		"maxPreparedDownloads",
		"preparedTtlMs"
	]) if (!Number.isSafeInteger(config[key]) || config[key] < 1) throw new Error(`sidebar-download: ${key} must be a positive safe integer`);
	if (!Number.isInteger(config.compressionLevel) || config.compressionLevel < 0 || config.compressionLevel > 9) throw new Error("sidebar-download: compressionLevel must be 0-9");
	if (config.preparedTtlMs > 2147483647) throw new Error("sidebar-download: preparedTtlMs exceeds the timer range");
	const limits = {
		...config,
		temporaryDirectory: config.temporaryDirectory ?? tmpdir()
	};
	if (!isAbsolute(limits.temporaryDirectory)) throw new Error("sidebar-download: temporaryDirectory must be absolute");
	const active = /* @__PURE__ */ new Map();
	const prepared = /* @__PURE__ */ new Map();
	const cleaning = /* @__PURE__ */ new Set();
	let preparing = 0;
	const release = async (ticket) => {
		const item = prepared.get(ticket);
		if (!item) return;
		prepared.delete(ticket);
		clearTimeout(item.timer);
		await item.result.dispose();
	};
	ctx.effect(() => {
		const unregister = ctx.webServer.register({
			kind: "exact",
			path: "/sidebar-download",
			async handler(req, res) {
				res.setHeader("Cache-Control", "no-store");
				res.setHeader("X-Content-Type-Options", "nosniff");
				const admission = ctx.connection.admit(req);
				if ("rejection" in admission) {
					res.writeHead(admission.rejection);
					res.end();
					return;
				}
				if (admission.peer.principal.kind !== "owner") {
					res.writeHead(403);
					res.end();
					return;
				}
				if (req.method !== "POST" && req.method !== "GET") {
					res.writeHead(405, { Allow: "GET, POST" });
					res.end();
					return;
				}
				if (req.method === "POST" && req.headers["content-type"]?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
					res.writeHead(415);
					res.end();
					return;
				}
				if (active.size >= config.maxConcurrent) {
					res.writeHead(429);
					res.end();
					return;
				}
				const controller = new AbortController();
				const cancel = () => {
					if (!res.writableFinished) controller.abort();
				};
				const stop = () => {
					req.destroy();
					res.destroy();
				};
				controller.signal.addEventListener("abort", stop, { once: true });
				res.on("close", cancel);
				const task = run(req, res, controller.signal);
				active.set(controller, task);
				try {
					await task;
				} finally {
					active.delete(controller);
					res.off("close", cancel);
					controller.signal.removeEventListener("abort", stop);
				}
			}
		});
		return async () => {
			unregister();
			for (const controller of active.keys()) controller.abort();
			await Promise.allSettled(active.values());
			const released = await Promise.allSettled([...prepared.keys()].map(release));
			await Promise.allSettled(cleaning);
			const failed = released.filter((result) => result.status === "rejected");
			if (failed.length) throw new AggregateError(failed.map((result) => result.reason), "Download temporary-file cleanup failed");
		};
	});
	async function run(req, res, signal) {
		try {
			if (req.method === "GET") {
				const ticket = new URL(req.url, "http://localhost").searchParams.get("ticket") ?? "";
				const item = prepared.get(ticket);
				if (!item) throw new DownloadError("expired", 404);
				prepared.delete(ticket);
				clearTimeout(item.timer);
				try {
					const result = item.result;
					res.writeHead(200, {
						"Content-Type": result.type,
						"Content-Length": result.size,
						"Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(result.name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16)}`)}`,
						"X-Download-Name": encodeURIComponent(result.name)
					});
					await pipeline(createReadStream(result.file), res, { signal });
				} finally {
					await item.result.dispose();
				}
				return;
			}
			const chunks = [];
			let size = 0;
			for await (const chunk of req) {
				signal.throwIfAborted();
				size += chunk.length;
				if (size > 65536) throw new DownloadError("invalid-selection", 413);
				chunks.push(chunk);
			}
			let body;
			try {
				body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch (error) {
				throw new DownloadError("invalid-selection", 400, { cause: error });
			}
			if (!body || typeof body.sessionId !== "string" || body.sessionId.length === 0) throw new DownloadError("invalid-selection");
			const header = ctx.sessions.get(body.sessionId)?.header ?? (await ctx.sessionPersistence?.stat(body.sessionId))?.header;
			if (!header) throw new DownloadError("not-found", 404);
			const scope = {
				sessionId: body.sessionId,
				workspaceRoot: header.cwd ?? ctx.sandboxPolicy.workspaceRoot
			};
			if (body.action === "list") {
				const path = selectionPaths([body.path])[0];
				const result = await directory(ctx.workspaceFiles, scope, path, signal);
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify(result));
			} else if (body.action === "download") {
				if (prepared.size + preparing >= config.maxPreparedDownloads) throw new DownloadError("busy", 429);
				preparing++;
				try {
					const result = await downloadSelection(ctx.workspaceFiles, scope, body.paths, limits, signal);
					if (signal.aborted) {
						await result.dispose();
						signal.throwIfAborted();
					}
					const ticket = randomUUID();
					const timer = setTimeout(() => {
						const task = release(ticket).catch((error) => {
							console.error("Download temporary-file cleanup failed", error);
						});
						cleaning.add(task);
						task.finally(() => cleaning.delete(task));
					}, config.preparedTtlMs);
					timer.unref();
					prepared.set(ticket, {
						result,
						timer
					});
					res.writeHead(200, { "Content-Type": "application/json" });
					res.end(JSON.stringify({
						ticket,
						name: result.name
					}));
				} finally {
					preparing--;
				}
			} else if (body.action === "discard" && typeof body.ticket === "string") {
				await release(body.ticket);
				res.writeHead(204);
				res.end();
			} else throw new DownloadError("invalid-selection");
		} catch (error) {
			if (res.destroyed) return;
			if (res.headersSent) {
				res.destroy();
				return;
			}
			const expected = error instanceof DownloadError;
			res.writeHead(expected ? error.status : 500, { "X-Download-Error": expected ? error.code : "read-failed" });
			res.end();
		}
	}
}
//#endregion
export { apply, inject };
