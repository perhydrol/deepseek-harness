/**
 * Validated configuration for the static-cache plugin.
 *
 * Values are deployment choices, so every one of them is a config field with a
 * documented default instead of a constant borrowed from elsewhere.
 */

/** Raw Loader row config accepted by {@link resolveConfig}. */
export interface StaticCacheConfig {
  /** Exact path serving the service worker script. */
  route?: string
  /** Service worker scope; must cover every cached prefix. */
  scope?: string
  /** Same-origin path prefixes the worker may store and serve. */
  prefixes?: string[]
  /** Exact paths inside a prefix that must keep hitting the network. */
  exclude?: string[]
  /** Fetch and store the current page's assets once, right after load. */
  prime?: boolean
  /** Parallel prefetch requests issued by the worker. */
  concurrency?: number
  /** Upper bound for the whole cache in bytes. */
  maxCacheBytes?: number
  /** Responses above this size are served but never stored. */
  maxEntryBytes?: number
  /** How long entries of a previous build survive a deploy. */
  graceMinutes?: number
  /** Unreferenced entries older than this are removed. */
  maxAgeDays?: number
  /** Revalidate stale entries that carry an ETag or Last-Modified. */
  revalidate?: boolean
}

/** Fully defaulted configuration consumed by the Host and the worker. */
export interface ResolvedStaticCacheConfig {
  route: string
  scope: string
  prefixes: readonly string[]
  exclude: readonly string[]
  prime: boolean
  concurrency: number
  maxCacheBytes: number
  maxEntryBytes: number
  graceMinutes: number
  maxAgeDays: number
  revalidate: boolean
}

/** Defaults shared by the plugin and the documented configuration. */
export const DEFAULTS = Object.freeze({
  route: '/__dsh-static-cache/sw.js',
  scope: '/',
  prefixes: Object.freeze(['/assets/', '/plugins/', '/font-replacement/']),
  exclude: Object.freeze(['/plugins/events']),
  prime: true,
  concurrency: 4,
  maxCacheBytes: 64 * 1024 * 1024,
  maxEntryBytes: 32 * 1024 * 1024,
  graceMinutes: 10,
  maxAgeDays: 30,
  revalidate: true,
})

/**
 * @param message - Failure detail appended to the plugin prefix.
 * @returns Never; always throws.
 */
function fail(message: string): never {
  throw new Error(`static-cache: ${message}`)
}

/**
 * @param value - Candidate route or scope.
 * @param fallback - Value used when the field is absent.
 * @param field - Field name used in the failure message.
 * @returns A validated absolute path without query or fragment.
 */
function pathField(value: unknown, fallback: string, field: string): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('?') || value.includes('#')) {
    fail(`${field} must be an absolute path without query or fragment`)
  }
  return value
}

/**
 * @param value - Candidate path list.
 * @param fallback - Value used when the field is absent.
 * @param field - Field name used in the failure message.
 * @returns A validated copy of the list.
 */
function pathList(value: unknown, fallback: readonly string[], field: string): readonly string[] {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.length === 0) fail(`${field} must be a non-empty array`)
  const paths: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.startsWith('/')) fail(`${field} entries must be absolute paths`)
    paths.push(entry)
  }
  return paths
}

/**
 * @param value - Candidate boolean.
 * @param fallback - Value used when the field is absent.
 * @param field - Field name used in the failure message.
 * @returns The validated boolean.
 */
function booleanField(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`)
  return value
}

/**
 * @param value - Candidate positive integer.
 * @param fallback - Value used when the field is absent.
 * @param field - Field name used in the failure message.
 * @returns The validated positive integer.
 */
function positiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) fail(`${field} must be a positive integer`)
  return value
}

/** Paths the worker refuses regardless of configuration. */
const RESERVED_PATHS = ['/api', '/_auth', '/connect']

/**
 * @param base - Directory-like base path.
 * @param path - Candidate path.
 * @returns Whether `path` is `base` or lives below it on a segment boundary.
 */
function within(base: string, path: string): boolean {
  if (base === '/') return path.startsWith('/')
  const prefix = base.endsWith('/') ? base : `${base}/`
  return path === base || path.startsWith(prefix)
}

/**
 * Apply defaults and validate one raw plugin config.
 * @param raw - Value from the Loader row's `config` field, if any.
 * @returns Frozen, fully defaulted configuration.
 * @throws When a supplied field is malformed; deployments fail at load, not at request time.
 */
export function resolveConfig(raw: unknown): ResolvedStaticCacheConfig {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    fail('config must be an object')
  }
  const value = (raw ?? {}) as StaticCacheConfig
  const prefixes = pathList(value.prefixes, DEFAULTS.prefixes, 'prefixes')
  const scope = pathField(value.scope, DEFAULTS.scope, 'scope')
  const route = pathField(value.route, DEFAULTS.route, 'route')
  for (const prefix of prefixes) {
    if (!within(scope, prefix)) fail(`prefix ${JSON.stringify(prefix)} is outside scope ${JSON.stringify(scope)}`)
    if (prefix === '/') fail('prefix "/" would cache every top-level path; name the versioned prefixes instead')
    for (const reserved of RESERVED_PATHS) {
      if (within(prefix, reserved) || within(reserved, prefix)) {
        fail(`prefix ${JSON.stringify(prefix)} overlaps reserved path ${JSON.stringify(reserved)}`)
      }
    }
  }
  if (!within(scope, route)) fail(`route ${JSON.stringify(route)} is outside scope ${JSON.stringify(scope)}`)
  for (const prefix of prefixes) {
    if (within(prefix, route)) fail(`route ${JSON.stringify(route)} must not live under cache prefix ${JSON.stringify(prefix)}`)
  }
  for (const reserved of RESERVED_PATHS) {
    if (within(reserved, route)) fail(`route ${JSON.stringify(route)} must not live under ${JSON.stringify(reserved)}`)
  }
  const exclude = pathList(value.exclude, DEFAULTS.exclude, 'exclude')
  for (const path of exclude) {
    if (!prefixes.some(prefix => within(prefix, path))) {
      fail(`exclude ${JSON.stringify(path)} is not under any cache prefix`)
    }
  }
  const maxCacheBytes = positiveInteger(value.maxCacheBytes, DEFAULTS.maxCacheBytes, 'maxCacheBytes')
  const maxEntryBytes = positiveInteger(value.maxEntryBytes, DEFAULTS.maxEntryBytes, 'maxEntryBytes')
  if (maxEntryBytes > maxCacheBytes) fail('maxEntryBytes must not exceed maxCacheBytes')
  return Object.freeze({
    route,
    scope,
    prefixes: Object.freeze([...prefixes]),
    exclude: Object.freeze([...exclude]),
    prime: booleanField(value.prime, DEFAULTS.prime, 'prime'),
    concurrency: positiveInteger(value.concurrency, DEFAULTS.concurrency, 'concurrency'),
    maxCacheBytes,
    maxEntryBytes,
    graceMinutes: positiveInteger(value.graceMinutes, DEFAULTS.graceMinutes, 'graceMinutes'),
    maxAgeDays: positiveInteger(value.maxAgeDays, DEFAULTS.maxAgeDays, 'maxAgeDays'),
    revalidate: booleanField(value.revalidate, DEFAULTS.revalidate, 'revalidate'),
  })
}
