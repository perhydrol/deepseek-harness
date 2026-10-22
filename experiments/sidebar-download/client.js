(function() {
	//#region experiments/sidebar-download/locale/en.json
	var ui$1 = {
		"download": "Download",
		"title": "Select files to download",
		"close": "Close",
		"up": "Parent directory",
		"all": "Select this directory",
		"prepare": "Prepare download",
		"cancel": "Cancel",
		"save": "Save download",
		"ready": "Ready to save",
		"loading": "Loading",
		"empty": "This directory is empty",
		"retry": "Retry",
		"selected": "Selected",
		"clear": "Clear selection",
		"open": "Open directory",
		"invalid-selection": "The selection contains an unsupported path.",
		"listing-truncated": "This directory exceeds the server listing limit. Choose a smaller directory.",
		"unsupported-entry": "The selection contains a link, alias, or unsupported entry.",
		"not-found": "The session or selected file no longer exists.",
		"size-limit": "The selection exceeds the download size limit. Select fewer files.",
		"entry-limit": "The selection contains too many entries. Select fewer files.",
		"read-failed": "Cannot prepare the download. Check access and file-size limits, then retry.",
		"incomplete-read": "The file could not be read completely. Retry the download.",
		"file-changed": "A file changed while being read. Prepare the download again.",
		"expired": "The prepared download expired or was already used. Prepare it again.",
		"busy": "The server is preparing other downloads. Try again shortly.",
		"denied": "Downloading requires the owner's authenticated browser session."
	};
	//#endregion
	//#region experiments/sidebar-download/locale/zh.json
	var ui = {
		"download": "下载",
		"title": "选择要下载的文件",
		"close": "关闭",
		"up": "上级目录",
		"all": "选择当前目录",
		"prepare": "准备下载",
		"cancel": "取消",
		"save": "保存下载",
		"ready": "已准备好，可以保存",
		"loading": "加载中",
		"empty": "当前目录为空",
		"retry": "重试",
		"selected": "已选",
		"clear": "清空选择",
		"open": "打开目录",
		"invalid-selection": "选择中包含不支持的路径",
		"listing-truncated": "目录条目超过服务端列表上限，请选择更小的目录",
		"unsupported-entry": "选择中包含链接、路径别名或不支持的文件类型",
		"not-found": "会话或所选文件已不存在",
		"size-limit": "所选内容超过下载大小上限，请减少文件",
		"entry-limit": "所选内容包含过多条目，请减少文件",
		"read-failed": "无法准备下载，请检查访问权限和文件大小限制后重试",
		"incomplete-read": "未能完整读取文件，请重试下载",
		"file-changed": "读取时文件发生变化，请重新准备下载",
		"expired": "下载已过期或已使用，请重新准备",
		"busy": "服务端正在准备其他下载，请稍后重试",
		"denied": "下载需要所有者已登录的浏览器会话"
	};
	//#endregion
	//#region experiments/sidebar-download/src/client.ts
	const NS = "local-sidebar-download";
	window.__ModuleLoader__.load({
		id: "@local/dsh-sidebar-download",
		factory(require) {
			const React = require("react");
			const h = React.createElement;
			function Action(props) {
				const [open, setOpen] = React.useState(false);
				return h(React.Fragment, null, h("button", {
					type: "button",
					className: "dsh-download-trigger",
					onClick: () => setOpen(true)
				}, props.t("download")), h("style", null, styles), open ? h(Picker, {
					...props,
					onClose: () => setOpen(false)
				}) : null);
			}
			function Picker({ sessionId, absolutePath, t, discard, onClose }) {
				const dialog = React.useRef(null);
				const [path, setPath] = React.useState("");
				const [entries, setEntries] = React.useState([]);
				const [selected, setSelected] = React.useState([]);
				const [loading, setLoading] = React.useState(true);
				const [busy, setBusy] = React.useState(false);
				const [error, setError] = React.useState("");
				const [revision, setRevision] = React.useState(0);
				const [ready, setReady] = React.useState(null);
				const operation = React.useRef(null);
				const previousTicket = React.useRef(null);
				const locked = React.useRef(false);
				React.useEffect(() => {
					const element = dialog.current;
					const previous = document.activeElement;
					element.showModal();
					return () => {
						operation.current?.abort();
						releaseCurrent();
						element.close();
						if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
					};
				}, []);
				React.useEffect(() => {
					const controller = new AbortController();
					setLoading(true);
					setError("");
					setEntries([]);
					request({
						action: "list",
						path
					}, controller.signal).then((response) => response.json()).then((result) => {
						if (!controller.signal.aborted) setEntries(result.entries);
					}).catch((cause) => {
						if (!controller.signal.aborted) setError(cause.message);
					}).finally(() => {
						if (!controller.signal.aborted) setLoading(false);
					});
					return () => controller.abort();
				}, [
					path,
					revision,
					sessionId
				]);
				async function request(body, signal) {
					const response = await fetch(new URL("sidebar-download", document.baseURI), {
						method: "POST",
						credentials: "same-origin",
						signal,
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							...body,
							sessionId
						})
					});
					if (!response.ok) {
						const code = response.headers.get("X-Download-Error") ?? (response.status === 429 ? "busy" : response.status === 401 || response.status === 403 ? "denied" : "read-failed");
						throw new Error(code);
					}
					return response;
				}
				function clearReady() {
					releaseCurrent();
					setReady(null);
				}
				function releaseCurrent() {
					if (previousTicket.current) discard(sessionId, previousTicket.current);
					previousTicket.current = null;
				}
				function change(next) {
					setSelected(next);
					clearReady();
					setError("");
				}
				async function prepare() {
					if (locked.current || selected.length === 0) return;
					locked.current = true;
					const controller = new AbortController();
					operation.current = controller;
					setBusy(true);
					setError("");
					clearReady();
					try {
						const result = await (await request({
							action: "download",
							paths: selected
						}, controller.signal)).json();
						controller.signal.throwIfAborted();
						if (typeof result?.ticket !== "string" || typeof result?.name !== "string") throw new Error("read-failed");
						previousTicket.current = result.ticket;
						const url = new URL("sidebar-download", document.baseURI);
						url.searchParams.set("ticket", result.ticket);
						setReady({
							ticket: result.ticket,
							url: url.href,
							name: result.name
						});
					} catch (cause) {
						if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "read-failed");
					} finally {
						locked.current = false;
						if (!controller.signal.aborted) setBusy(false);
					}
				}
				const toggle = (value) => change(selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value]);
				const errorKey = error in ui$1 ? error : "read-failed";
				return h("dialog", {
					ref: dialog,
					className: "dsh-download-dialog",
					"aria-label": t("title"),
					onCancel: (event) => {
						event.preventDefault();
						onClose();
					},
					onClick: (event) => {
						if (event.target === event.currentTarget) {
							const box = event.currentTarget.getBoundingClientRect();
							if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
						}
					}
				}, h("div", { className: "dsh-download-heading" }, h("span", null, t("title")), h("button", {
					type: "button",
					onClick: onClose,
					autoFocus: true
				}, t("close"))), h("div", { className: "dsh-download-path" }, `${absolutePath.replace(/[\\/]$/, "")}/${path}`), h("div", { className: "dsh-download-toolbar" }, h("button", {
					type: "button",
					disabled: !path || busy,
					onClick: () => setPath(path.split("/").slice(0, -1).join("/"))
				}, t("up")), h("label", null, h("input", {
					type: "checkbox",
					checked: selected.includes(path),
					disabled: busy,
					onChange: () => toggle(path)
				}), t("all"))), h("div", {
					className: "dsh-download-list",
					"aria-busy": loading || busy
				}, loading ? h("div", {
					className: "dsh-download-center",
					role: "status",
					"aria-label": t("loading")
				}, "…") : null, !loading && !error && entries.length === 0 ? h("div", { className: "dsh-download-center" }, t("empty")) : null, ...entries.map((entry) => {
					const value = path ? `${path}/${entry.name}` : entry.name;
					return h("div", {
						key: value,
						className: "dsh-download-row"
					}, h("label", null, h("input", {
						type: "checkbox",
						checked: selected.includes(value),
						disabled: busy || entry.type === "other",
						onChange: () => toggle(value)
					}), h("span", null, entry.name)), entry.type === "directory" ? h("button", {
						type: "button",
						disabled: busy,
						"aria-label": `${t("open")}: ${entry.name}`,
						onClick: () => setPath(value)
					}, "›") : null);
				})), error ? h("div", {
					role: "alert",
					className: "dsh-download-error"
				}, t(errorKey), " ", h("button", {
					type: "button",
					disabled: busy,
					onClick: () => setRevision((value) => value + 1)
				}, t("retry"))) : null, h("div", { className: "dsh-download-footer" }, h("span", null, `${t("selected")}: ${selected.length}`), h("button", {
					type: "button",
					disabled: busy || selected.length === 0,
					onClick: () => change([])
				}, t("clear")), busy ? h("button", {
					type: "button",
					onClick: () => {
						operation.current?.abort();
						setBusy(false);
					}
				}, t("cancel")) : h(React.Fragment, null, ready ? h("a", {
					href: ready.url,
					download: ready.name
				}, t("save")) : null, h("button", {
					type: "button",
					disabled: selected.length === 0 || loading,
					onClick: () => {
						prepare();
					}
				}, t("prepare")))), ready ? h("div", { role: "status" }, t("ready")) : null);
			}
			return {
				inject: ["slots", "locale"],
				apply(ctx) {
					ctx.effect(() => ctx.locale.register(NS, {
						en: ui$1,
						zh: ui
					}));
					ctx.effect(() => {
						const lifetime = new AbortController();
						const pending = /* @__PURE__ */ new Set();
						const discard = (sessionId, ticket) => {
							if (lifetime.signal.aborted) return;
							const task = fetch(new URL("sidebar-download", document.baseURI), {
								method: "POST",
								credentials: "same-origin",
								keepalive: true,
								signal: lifetime.signal,
								headers: { "Content-Type": "application/json" },
								body: JSON.stringify({
									action: "discard",
									sessionId,
									ticket
								})
							}).then((response) => {
								if (!response.ok) console.warn("Prepared download release failed; expiry will retry cleanup");
							}).catch((error) => {
								if (!lifetime.signal.aborted) console.warn("Prepared download release failed; expiry will retry cleanup", error);
							});
							pending.add(task);
							task.finally(() => pending.delete(task));
						};
						const unregister = ctx.slots.inject("sidebar.right.tab.files.actions", () => ctx.slots.register({
							name: "sidebar.right.tab.files.actions",
							id: "local-sidebar-download",
							locale: NS,
							inject: () => ({ discard })
						}, Action));
						return async () => {
							unregister();
							lifetime.abort();
							await Promise.allSettled(pending);
						};
					});
				}
			};
		}
	});
	const styles = `
.dsh-download-trigger,.dsh-download-dialog button,.dsh-download-dialog a {
  font:inherit;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  border:1px solid var(--dsw-alias-border-l3);border-radius:6px;padding:5px 9px;cursor:pointer;
}
.dsh-download-dialog {box-sizing:border-box;width:min(560px,calc(100vw - 32px));max-height:calc(100dvh - 48px);
  padding:16px;border:1px solid var(--dsw-alias-border-l3);border-radius:12px;
  color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);
  font-size:var(--dsh-content-font-size-secondary,13px);overflow:auto;
}
.dsh-download-dialog::backdrop {background:var(--dsw-alias-bg-mask-1)}
.dsh-download-dialog[open] {display:flex;flex-direction:column;gap:12px}
.dsh-download-heading,.dsh-download-toolbar,.dsh-download-footer,.dsh-download-row {display:flex;align-items:center;gap:8px}
.dsh-download-heading {justify-content:space-between;font-weight:500}
.dsh-download-toolbar,.dsh-download-footer {flex-wrap:wrap}
.dsh-download-path {overflow-wrap:anywhere;color:var(--dsw-alias-label-secondary)}
.dsh-download-list {min-height:100px;max-height:45dvh;overflow:auto;flex:1 1 auto}
.dsh-download-row {min-height:36px;padding:2px 4px;justify-content:space-between}
.dsh-download-row label {flex:1;min-width:0;overflow-wrap:anywhere}
.dsh-download-dialog label {display:flex;align-items:center;gap:8px;cursor:pointer}
.dsh-download-dialog input {flex-shrink:0;width:18px;height:18px}
.dsh-download-dialog button:disabled {opacity:.5;cursor:default}
.dsh-download-dialog a {text-decoration:none}
.dsh-download-error {color:var(--dsw-alias-label-primary);overflow-wrap:anywhere}
.dsh-download-center {display:flex;align-items:center;justify-content:center;min-height:100px}
`;
	//#endregion
})();
