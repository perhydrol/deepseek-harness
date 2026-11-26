import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/** Browser, service-worker, and Node globals used by the static-cache plugin. */
const staticCacheGlobals = {
  self: 'readonly',
  caches: 'readonly',
  clients: 'readonly',
  fetch: 'readonly',
  Request: 'readonly',
  Response: 'readonly',
  Headers: 'readonly',
  URL: 'readonly',
  URLSearchParams: 'readonly',
  MessageChannel: 'readonly',
  navigator: 'readonly',
  document: 'readonly',
  location: 'readonly',
  performance: 'readonly',
  globalThis: 'readonly',
  addEventListener: 'readonly',
  setTimeout: 'readonly',
  clearTimeout: 'readonly',
  console: 'readonly',
  process: 'readonly',
  __DSH_BOOT__: 'readonly',
  __DSH_STATIC_CACHE__: 'writable',
}

export default tseslint.config(
  { ignores: ['dist/**', 'static-cache/dist/**', 'node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['static-cache/**/*.{js,ts}'],
    languageOptions: { globals: staticCacheGlobals },
  },
)
