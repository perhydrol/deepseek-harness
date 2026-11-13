/**
 * Validated configuration for the static-cache plugin.
 *
 * Values are deployment choices, so every one of them is a config field with a
 * documented default instead of a constant borrowed from elsewhere.
 */

/**
 * @typedef {object} StaticCacheConfig
 * @property {string} [route] Exact path serving the service worker script.
 * @property {string} [scope] Service worker scope; must cover every cached prefix.
 * @property {string[]} [prefixes] Same-origin path prefixes the worker may store and serve.
 * @property {string[]} [exclude] Exact paths inside a prefix that must keep hitting the network.
 * @property {boolean} [prime] Fetch and store the current page's assets once, right after load.
 * @property {number} [concurrency] Parallel prefetch requests issued by the worker.
 * @property {number} [maxCacheBytes] Upper bound for the whole cache in bytes.
 * @property {number} [maxEntryBytes] Responses above this size are served but never stored.
 * @property {number} [graceMinutes] How long entries of a previous build survive a deploy.
 * @property {number} [maxAgeDays] Unreferenced entries older than this are removed.
 */

/**
 * @typedef {object} ResolvedStaticCacheConfig
 * @property {string} route
 * @property {string} scope
 * @property {readonly string[]} prefixes
 * @property {readonly string[]} exclude
 * @property {boolean} prime
 * @property {number} concurrency
 * @property {number} maxCacheBytes
 * @property {number} maxEntryBytes
 * @property {number} graceMinutes
 * @property {number} maxAgeDays
 */

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
})

/**
 * @param {string} message
 * @returns {never}
 */
function fail(message) {
  throw new Error(`static-cache: ${message}`)
}

/**
 * @param {unknown} value
 * @param {string} fallback
 * @param {string} field
 * @returns {string}
 */
function pathField(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || !value.startsWith('/') || value.includes('?') || value.includes('#')) {
    fail(`${field} must be an absolute path without query or fragment`)
  }
  return value
}

/**
 * @param {unknown} value
 * @param {readonly string[]} fallback
 * @param {string} field
 * @returns {readonly string[]}
 */
function pathList(value, fallback, field) {
  if (value === undefined) return [...fallback]
  if (!Array.isArray(value) || value.length === 0) fail(`${field} must be a non-empty array`)
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.startsWith('/')) fail(`${field} entries must be absolute paths`)
  }
  return [...value]
}

/**
 * @param {unknown} value
 * @param {boolean} fallback
 * @param {string} field
 * @returns {boolean}
 */
function booleanField(value, fallback, field) {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') fail(`${field} must be a boolean`)
  return value
}

/**
 * @param {unknown} value
 * @param {number} fallback
 * @param {string} field
 * @returns {number}
 */
function positiveInteger(value, fallback, field) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || /** @type {number} */ (value) <= 0) fail(`${field} must be a positive integer`)
  return /** @type {number} */ (value)
}

/** Paths the worker refuses regardless of configuration. */
const RESERVED_PATHS = ['/api', '/_auth', '/connect']

/**
 * @param {string} base Directory-like base path.
 * @param {string} path Candidate path.
 * @returns {boolean} Whether `path` is `base` or lives below it on a segment boundary.
 */
function within(base, path) {
  if (base === '/') return path.startsWith('/')
  const prefix = base.endsWith('/') ? base : `${base}/`
  return path === base || path.startsWith(prefix)
}

/**
 * Apply defaults and validate one raw plugin config.
 * @param {unknown} raw Value from the Loader row's `config` field, if any.
 * @returns {ResolvedStaticCacheConfig} Frozen, fully defaulted configuration.
 * @throws when a supplied field is malformed; deployments fail at load, not at request time.
 */
export function resolveConfig(raw) {
  if (raw !== undefined && (typeof raw !== 'object' || raw === null || Array.isArray(raw))) {
    fail('config must be an object')
  }
  const value = /** @type {StaticCacheConfig} */ (raw ?? {})
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
  })
}
