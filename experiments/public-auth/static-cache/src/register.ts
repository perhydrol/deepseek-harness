/**
 * Builds the inline script that registers the service worker after login and
 * primes it with the assets the current page has already loaded.
 *
 * The script is serialized from {@link bootstrap}, so its behavior is testable
 * as a plain function and the injected text stays readable.
 */

import type { ResolvedStaticCacheConfig } from './config.js'

/** Page boot data injected by the Web shell. */
interface DshBoot {
  rev?: string
  batches?: Array<{ url?: string }>
}

/** Debug and maintenance interface exposed to the authenticated page. */
interface DshStaticCacheHandle {
  stats(): Promise<unknown>
  prime(): Promise<unknown>
  purge(): Promise<unknown>
}

declare global {
  var __DSH_BOOT__: DshBoot | undefined
  var __DSH_STATIC_CACHE__: DshStaticCacheHandle | undefined
}

/** Configuration consumed by the serialized page script. */
export interface PageScriptConfig {
  route: string
  scope: string
  prefixes: string[]
  exclude: string[]
  prime: boolean
  concurrency: number
  maxCacheBytes: number
  maxEntryBytes: number
  graceMs: number
  maxAgeMs: number
}

/**
 * Browser-side registration. Serialized with `Function.prototype.toString` and
 * invoked with the resolved configuration as its only argument.
 * @param CONFIG - Registration and prefetch settings.
 * @returns Nothing.
 */
function bootstrap(CONFIG: PageScriptConfig): void {
  if (!('serviceWorker' in navigator)) return

  let worker: ServiceWorker | null = null

  /**
   * @param pathname - Same-origin pathname.
   * @returns Whether the worker may store and serve this path.
   */
  const allowed = (pathname: string): boolean => CONFIG.prefixes.some(prefix => pathname.startsWith(prefix))
    && !CONFIG.exclude.includes(pathname)

  /**
   * @param value - Document-relative URL.
   * @returns An absolute URL, or null when it cannot be parsed.
   */
  const absolute = (value: string): URL | null => {
    try {
      return new URL(value, location.href)
    } catch {
      return null
    }
  }

  /** @returns Document-relative URLs the worker may store. */
  const collect = (): string[] => {
    const urls = new Set<string>()
    /** @param value - Candidate URL from the document. */
    const add = (value: string): void => {
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
    if (boot !== undefined && Array.isArray(boot.batches)) {
      for (const batch of boot.batches) if (typeof batch.url === 'string') add(batch.url)
    }
    return [...urls]
  }

  /** @returns Client graph revision of the current page. */
  const revision = (): string | null => {
    const boot = globalThis.__DSH_BOOT__
    return boot !== undefined && typeof boot.rev === 'string' && boot.rev !== ''
      ? boot.rev
      : null
  }

  /**
   * @param message - Structured worker message.
   * @returns Reply payload, or null when no worker is active.
   */
  const send = (message: Record<string, unknown>): Promise<unknown> => new Promise((resolve) => {
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

  /** @returns Nothing; registration failures are reported once. */
  const start = async (): Promise<void> => {
    const registration = await navigator.serviceWorker.register(CONFIG.route, {
      scope: CONFIG.scope,
      updateViaCache: 'none',
    })
    await navigator.serviceWorker.ready
    worker = registration.active ?? navigator.serviceWorker.controller
    await send({ type: 'init', rev: revision(), timeOrigin: performance.timeOrigin })
    if (CONFIG.prime) await send({ type: 'prime', urls: collect() })
  }

  const boot = (): void => {
    start().catch((error: unknown) => {
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
 * @param config - Resolved plugin configuration.
 * @returns Configuration consumed by the page script.
 */
export function pageScriptConfig(config: ResolvedStaticCacheConfig): PageScriptConfig {
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
 * @param config - Resolved plugin configuration.
 * @returns Inline script text safe to place inside a `<script>` element.
 */
export function registerScript(config: ResolvedStaticCacheConfig): string {
  const script = `(${bootstrap.toString()})(${JSON.stringify(pageScriptConfig(config))})`
  // A row text cannot close the script element early.
  if (/<\/script/i.test(script)) throw new Error('static-cache: registration script contains a closing script tag')
  return script
}
