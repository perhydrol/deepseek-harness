/** Minimal Cache Storage and service-worker host used by the worker tests. */

import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const CONFIG_MARKER = '/* dsh-static-cache:config */null'

/** Policy the Host would bake into the served worker. */
export const DEFAULT_WORKER_CONFIG = Object.freeze({
  prefixes: ['/assets/', '/plugins/', '/font-replacement/'],
  exclude: ['/plugins/events'],
  concurrency: 4,
  maxCacheBytes: 64 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  graceMs: 600_000,
  maxAgeMs: 30 * 24 * 60 * 60 * 1000,
})

/** @param {Partial<typeof DEFAULT_WORKER_CONFIG>} [overrides] */
export function workerConfig(overrides = {}) {
  return { ...DEFAULT_WORKER_CONFIG, ...overrides }
}

/** @param {Request | string | { url: string }} request */
function keyOf(request) {
  if (typeof request === 'string') return new URL(request, 'https://dsh.test/').href
  return request.url
}

class FakeCache {
  constructor() {
    /** @type {Map<string, { body: ArrayBuffer; status: number; headers: [string, string][]; url: string }>} */
    this.entries = new Map()
    /** @type {Set<string>} */
    this.failing = new Set()
  }

  /** @param {Request | string} request */
  async match(request) {
    const key = keyOf(request)
    if (this.failing.delete(key)) throw new Error('fake storage failure')
    const entry = this.entries.get(key)
    if (entry === undefined) return undefined
    return new Response(entry.body.slice(0), { status: entry.status, headers: entry.headers })
  }

  /**
   * @param {Request | string} request
   * @param {Response} response
   */
  async put(request, response) {
    this.entries.set(keyOf(request), {
      body: await response.clone().arrayBuffer(),
      status: response.status,
      headers: [...response.headers],
      url: response.url,
    })
  }

  /** @param {Request | string} request */
  async delete(request) {
    return this.entries.delete(keyOf(request))
  }

  async keys() {
    return [...this.entries.keys()].map(url => new Request(url))
  }
}

class FakeCaches {
  constructor() {
    /** @type {Map<string, FakeCache>} */
    this.stores = new Map()
  }

  /** @param {string} name */
  async open(name) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache())
    return /** @type {FakeCache} */ (this.stores.get(name))
  }

  async keys() {
    return [...this.stores.keys()]
  }

  /** @param {string} name */
  async delete(name) {
    return this.stores.delete(name)
  }

  /** @param {string} name */
  has(name) {
    return this.stores.has(name)
  }

  /** @param {string} name */
  entries(name) {
    return this.stores.get(name)?.entries ?? new Map()
  }

  /** @param {string} name @param {string} url */
  failNextMatch(name, url) {
    this.stores.get(name)?.failing.add(url)
  }
}

/**
 * Evaluate the worker source against a controllable fake host.
 * @param {{ fetch?: (request: unknown) => Promise<Response>, now?: number, config?: object, caches?: FakeCaches }} [options]
 */
export function createWorker(options = {}) {
  const listeners = new Map()
  const clock = { now: options.now ?? 1_000_000 }
  const caches = options.caches ?? new FakeCaches()
  const calls = []

  /** @param {unknown} request */
  const urlOf = request => {
    if (typeof request === 'string') return new URL(request, 'https://dsh.test/').href
    return /** @type {{ url: string }} */ (request).url
  }

  const defaultFetch = async (request) => {
    const url = urlOf(request)
    if (new URL(url).pathname === '/_auth/session') return new Response('{}')
    calls.push(url)
    return new Response(`body:${url}`, { status: 200, headers: { 'content-length': String(url.length), 'x-dsh-upstream-cache-control': 'private, max-age=60' } })
  }

  const self = {
    location: new URL('https://dsh.test/'),
    /** @param {string} type @param {Function} listener */
    addEventListener: (type, listener) => {
      const group = listeners.get(type) ?? []
      group.push(listener)
      listeners.set(type, group)
    },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  }

  class FakeDate extends Date {
    static now() {
      return clock.now
    }
  }

  const source = readFileSync(new URL('../src/service-worker.js', import.meta.url), 'utf8')
  if (source.split(CONFIG_MARKER).length !== 2) throw new Error('worker source lost its config marker')
  const configured = source.replace(CONFIG_MARKER, JSON.stringify(options.config ?? DEFAULT_WORKER_CONFIG))

  const context = vm.createContext({
    self,
    caches,
    fetch: options.fetch ?? defaultFetch,
    Request,
    Response,
    Headers,
    URL,
    URLSearchParams,
    console,
    Date: FakeDate,
    setTimeout,
    clearTimeout,
  })
  vm.runInContext(configured, context, { filename: 'service-worker.js' })

  /** @param {string} type @param {object} event */
  const dispatch = (type, event) => {
    for (const listener of listeners.get(type) ?? []) listener(event)
  }

  /**
   * @param {object} data
   * @returns {Promise<unknown>} The reply payload.
   */
  const message = async (data) => {
    /** @type {Promise<unknown>[]} */
    const waiting = []
    const replies = []
    dispatch('message', {
      data,
      ports: [{ postMessage: value => replies.push(value) }],
      waitUntil: promise => waiting.push(promise),
    })
    await Promise.all(waiting)
    return replies.at(-1)
  }

  /**
   * @param {Request | { url: string; method: string; mode: string; headers: Headers }} request
   * @returns {Promise<{ handled: boolean, response?: Response }>} The intercepted answer, if any.
   */
  const fetchEvent = async (request) => {
    /** @type {Promise<Response> | undefined} */
    let responded
    /** @type {Promise<unknown>[]} */
    const waiting = []
    dispatch('fetch', {
      request,
      respondWith: promise => { responded = promise },
      waitUntil: promise => waiting.push(promise),
    })
    if (responded === undefined) return { handled: false }
    const response = await responded
    await Promise.all(waiting)
    return { handled: true, response }
  }

  return { self, caches, calls, clock, message, fetchEvent, dispatch }
}
