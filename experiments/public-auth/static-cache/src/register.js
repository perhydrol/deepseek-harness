/**
 * Builds the inline script that registers the service worker after login and
 * primes it with the assets the current page has already loaded.
 *
 * The script is serialized from {@link bootstrap}, so its behavior is
 * testable as a plain function and the injected text stays readable.
 */

/**
 * @typedef {import('./config.js').ResolvedStaticCacheConfig} ResolvedStaticCacheConfig
 */

/**
 * @typedef {object} PageScriptConfig
 * @property {string} route
 * @property {string} scope
 * @property {string[]} prefixes
 * @property {string[]} exclude
 * @property {boolean} prime
 * @property {number} concurrency
 * @property {number} maxCacheBytes
 * @property {number} maxEntryBytes
 * @property {number} graceMs
 * @property {number} maxAgeMs
 */

/**
 * Browser-side registration. Serialized with `Function.prototype.toString` and
 * invoked with the resolved configuration as its only argument.
 * @param {PageScriptConfig} CONFIG
 * @returns {void}
 */
function bootstrap(CONFIG) {
  if (!('serviceWorker' in navigator)) return

  let worker = null

  /** @param {string} pathname @returns {boolean} */
  const allowed = pathname => CONFIG.prefixes.some(prefix => pathname.startsWith(prefix))
    && !CONFIG.exclude.includes(pathname)

  /** @param {string} value @returns {URL | null} */
  const absolute = (value) => {
    try {
      return new URL(value, location.href)
    } catch {
      return null
    }
  }

  /** @returns {string[]} Document-relative URLs the worker may store. */
  const collect = () => {
    const urls = new Set()
    /** @param {string} value */
    const add = (value) => {
      const url = absolute(value)
      if (url === null || url.origin !== location.origin || !allowed(url.pathname)) return
      urls.add(url.pathname + url.search)
    }
    for (const entry of performance.getEntriesByType('resource')) add(entry.name)
    for (const element of document.querySelectorAll('script[src],link[href]')) {
      const value = element.getAttribute('src') ?? element.getAttribute('href')
      if (value !== null) add(value)
    }
    const boot = globalThis.__DSH_BOOT__
    if (boot !== null && typeof boot === 'object' && Array.isArray(boot.batches)) {
      for (const batch of boot.batches) if (typeof batch.url === 'string') add(batch.url)
    }
    return [...urls]
  }

  /** @returns {string | null} Client graph revision of the current page. */
  const revision = () => {
    const boot = globalThis.__DSH_BOOT__
    return boot !== null && typeof boot === 'object' && typeof boot.rev === 'string' && boot.rev !== ''
      ? boot.rev
      : null
  }

  /**
   * @param {object} message
   * @returns {Promise<unknown>} Reply payload, or null when no worker is active.
   */
  const send = message => new Promise((resolve) => {
    const target = navigator.serviceWorker.controller ?? worker
    if (target === null) {
      resolve(null)
      return
    }
    const channel = new MessageChannel()
    const timer = setTimeout(() => resolve(null), 10000)
    channel.port1.onmessage = (event) => {
      clearTimeout(timer)
      resolve(event.data)
    }
    try {
      target.postMessage(message, [channel.port2])
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })

  /** @returns {Promise<void>} */
  const start = async () => {
    const registration = await navigator.serviceWorker.register(CONFIG.route, {
      scope: CONFIG.scope,
      updateViaCache: 'none',
    })
    await navigator.serviceWorker.ready
    worker = registration.active ?? navigator.serviceWorker.controller
    await send({ type: 'init', rev: revision(), timeOrigin: performance.timeOrigin })
    if (CONFIG.prime) await send({ type: 'prime', urls: collect() })
  }

  const boot = () => {
    start().catch((error) => {
      console.warn('dsh-static-cache: registration failed', error)
    })
  }
  if (document.readyState === 'complete') setTimeout(boot, 0)
  else addEventListener('load', boot, { once: true })

  globalThis.__DSH_STATIC_CACHE__ = {
    stats: () => send({ type: 'stats' }),
    prime: () => send({ type: 'prime', urls: collect() }),
    purge: () => send({ type: 'purge' }),
  }
}

/**
 * Build the worker message payload for one resolved configuration.
 * @param {ResolvedStaticCacheConfig} config Resolved plugin configuration.
 * @returns {PageScriptConfig} Configuration consumed by the page script.
 */
export function pageScriptConfig(config) {
  return {
    route: config.route,
    scope: config.scope,
    prefixes: [...config.prefixes],
    exclude: [...config.exclude],
    prime: config.prime,
    concurrency: config.concurrency,
    maxCacheBytes: config.maxCacheBytes,
    maxEntryBytes: config.maxEntryBytes,
    graceMs: config.graceMinutes * 60_000,
    maxAgeMs: config.maxAgeDays * 86_400_000,
  }
}

/**
 * Serialize the registration script for one resolved configuration.
 * @param {ResolvedStaticCacheConfig} config Resolved plugin configuration.
 * @returns {string} Inline script text safe to place inside a `<script>` element.
 */
export function registerScript(config) {
  const script = `(${bootstrap.toString()})(${JSON.stringify(pageScriptConfig(config))})`
  // A row text cannot close the script element early.
  if (/<\/script/i.test(script)) throw new Error('static-cache: registration script contains a closing script tag')
  return script
}
