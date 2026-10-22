/** Sidebar-owned selection dialog; the Host prepares ZIP bytes before transfer. */
import type * as ReactTypes from 'react';
import en from '../locale/en.json' with { type: 'json' };
import zh from '../locale/zh.json' with { type: 'json' };
import type { Entry } from './download.ts';

type Translate = (key: string) => string;
interface Props { sessionId: string; absolutePath: string; t: Translate; discard(sessionId: string, ticket: string): void }
interface Client {
  locale: { register(namespace: string, dictionaries: object): () => void };
  effect(effect: () => () => void | Promise<void>): void;
  slots: {
    inject(name: string, callback: () => unknown): () => void;
    register(options: object, component: ReactTypes.ComponentType<Props>): () => void;
  };
}
declare global {
  interface Window {
    __ModuleLoader__: { load(module: { id: string; factory(require: (name: string) => typeof ReactTypes): object }): void };
  }
}
const NS = 'local-sidebar-download';
window.__ModuleLoader__.load({
  id: '@local/dsh-sidebar-download',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    function Action(props: Props) {
      const [open, setOpen] = React.useState(false);
      return h(React.Fragment, null,
        h('button', { type: 'button', className: 'dsh-download-trigger', onClick: () => setOpen(true) }, props.t('download')),
        h('style', null, styles),
        open ? h(Picker, { ...props, onClose: () => setOpen(false) }) : null);
    }
    function Picker({ sessionId, absolutePath, t, discard, onClose }: Props & { onClose(): void }) {
      const dialog = React.useRef<HTMLDialogElement>(null);
      const [path, setPath] = React.useState('');
      const [entries, setEntries] = React.useState<Entry[]>([]);
      const [selected, setSelected] = React.useState<string[]>([]);
      const [loading, setLoading] = React.useState(true);
      const [busy, setBusy] = React.useState(false);
      const [error, setError] = React.useState('');
      const [revision, setRevision] = React.useState(0);
      const [ready, setReady] = React.useState<{ ticket: string; url: string; name: string } | null>(null);
      const operation = React.useRef<AbortController | null>(null);
      const previousTicket = React.useRef<string | null>(null);
      const locked = React.useRef(false);
      React.useEffect(() => {
        const element = dialog.current!;
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
        setLoading(true); setError(''); setEntries([]);
        void request({ action: 'list', path }, controller.signal).then(response => response.json()).then(result => {
          if (!controller.signal.aborted) setEntries(result.entries);
        }).catch((cause: Error) => { if (!controller.signal.aborted) setError(cause.message); })
          .finally(() => { if (!controller.signal.aborted) setLoading(false); });
        return () => controller.abort();
      }, [path, revision, sessionId]);
      async function request(body: object, signal: AbortSignal) {
        const response = await fetch(new URL('sidebar-download', document.baseURI), {
          method: 'POST', credentials: 'same-origin', signal,
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, sessionId }),
        });
        if (!response.ok) {
          const code = response.headers.get('X-Download-Error') ?? (response.status === 429 ? 'busy'
            : response.status === 401 || response.status === 403 ? 'denied' : 'read-failed');
          throw new Error(code);
        }
        return response;
      }
      function clearReady() {
        releaseCurrent(); setReady(null);
      }
      function releaseCurrent() {
        if (previousTicket.current) discard(sessionId, previousTicket.current);
        previousTicket.current = null;
      }
      function change(next: string[]) { setSelected(next); clearReady(); setError(''); }
      async function prepare() {
        if (locked.current || selected.length === 0) return;
        locked.current = true;
        const controller = new AbortController();
        operation.current = controller;
        setBusy(true); setError(''); clearReady();
        try {
          const response = await request({ action: 'download', paths: selected }, controller.signal);
          const result = await response.json();
          controller.signal.throwIfAborted();
          if (typeof result?.ticket !== 'string' || typeof result?.name !== 'string') throw new Error('read-failed');
          previousTicket.current = result.ticket;
          const url = new URL('sidebar-download', document.baseURI);
          url.searchParams.set('ticket', result.ticket);
          setReady({ ticket: result.ticket, url: url.href, name: result.name });
        } catch (cause) {
          if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'read-failed');
        } finally {
          locked.current = false;
          if (!controller.signal.aborted) setBusy(false);
        }
      }
      const toggle = (value: string) => change(selected.includes(value) ? selected.filter(item => item !== value) : [...selected, value]);
      const errorKey = error in en.ui ? error : 'read-failed';
      return h('dialog', {
        ref: dialog, className: 'dsh-download-dialog', 'aria-label': t('title'),
        onCancel: (event: ReactTypes.SyntheticEvent) => { event.preventDefault(); onClose(); },
        onClick: (event: ReactTypes.MouseEvent<HTMLDialogElement>) => { if (event.target === event.currentTarget) {
          const box = event.currentTarget.getBoundingClientRect();
          if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose();
        } },
      },
      h('div', { className: 'dsh-download-heading' }, h('span', null, t('title')),
        h('button', { type: 'button', onClick: onClose, autoFocus: true }, t('close'))),
      h('div', { className: 'dsh-download-path' }, `${absolutePath.replace(/[\\/]$/, '')}/${path}`),
      h('div', { className: 'dsh-download-toolbar' },
        h('button', { type: 'button', disabled: !path || busy, onClick: () => setPath(path.split('/').slice(0, -1).join('/')) }, t('up')),
        h('label', null, h('input', { type: 'checkbox', checked: selected.includes(path), disabled: busy,
          onChange: () => toggle(path) }), t('all'))),
      h('div', { className: 'dsh-download-list', 'aria-busy': loading || busy },
        loading ? h('div', { className: 'dsh-download-center', role: 'status', 'aria-label': t('loading') }, '…') : null,
        !loading && !error && entries.length === 0 ? h('div', { className: 'dsh-download-center' }, t('empty')) : null,
        ...entries.map(entry => {
          const value = path ? `${path}/${entry.name}` : entry.name;
          return h('div', { key: value, className: 'dsh-download-row' },
            h('label', null, h('input', { type: 'checkbox', checked: selected.includes(value), disabled: busy || entry.type === 'other',
              onChange: () => toggle(value) }), h('span', null, entry.name)),
            entry.type === 'directory' ? h('button', { type: 'button', disabled: busy, 'aria-label': `${t('open')}: ${entry.name}`,
              onClick: () => setPath(value) }, '›') : null);
        })),
      error ? h('div', { role: 'alert', className: 'dsh-download-error' }, t(errorKey), ' ',
        h('button', { type: 'button', disabled: busy, onClick: () => setRevision(value => value + 1) }, t('retry'))) : null,
      h('div', { className: 'dsh-download-footer' },
        h('span', null, `${t('selected')}: ${selected.length}`),
        h('button', { type: 'button', disabled: busy || selected.length === 0, onClick: () => change([]) }, t('clear')),
        busy ? h('button', { type: 'button', onClick: () => { operation.current?.abort(); setBusy(false); } }, t('cancel'))
          : h(React.Fragment, null,
            ready ? h('a', { href: ready.url, download: ready.name }, t('save')) : null,
            h('button', { type: 'button', disabled: selected.length === 0 || loading, onClick: () => { void prepare(); } }, t('prepare')))),
      ready ? h('div', { role: 'status' }, t('ready')) : null);
    }
    return {
      inject: ['slots', 'locale'],
      apply(ctx: Client) {
        ctx.effect(() => ctx.locale.register(NS, { en: en.ui, zh: zh.ui }));
        ctx.effect(() => {
          const lifetime = new AbortController();
          const pending = new Set<Promise<void>>();
          const discard = (sessionId: string, ticket: string) => {
            if (lifetime.signal.aborted) return;
            const task = fetch(new URL('sidebar-download', document.baseURI), {
              method: 'POST', credentials: 'same-origin', keepalive: true, signal: lifetime.signal,
              headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'discard', sessionId, ticket }),
            }).then(response => {
              if (!response.ok) console.warn('Prepared download release failed; expiry will retry cleanup');
            }).catch(error => {
              if (!lifetime.signal.aborted) console.warn('Prepared download release failed; expiry will retry cleanup', error);
            });
            pending.add(task); void task.finally(() => pending.delete(task));
          };
          const unregister = ctx.slots.inject('sidebar.right.tab.files.actions', () => ctx.slots.register({
            name: 'sidebar.right.tab.files.actions', id: 'local-sidebar-download', locale: NS,
            inject: () => ({ discard }),
          }, Action));
          return async () => {
            unregister(); lifetime.abort();
            await Promise.allSettled(pending);
          };
        });
      },
    };
  },
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
