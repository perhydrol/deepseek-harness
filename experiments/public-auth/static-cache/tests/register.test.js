import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'
import { pageScriptConfig, registerScript } from '../src/register.js'

const config = resolveConfig({})

test('serializes a parseable script', () => {
  const script = registerScript(config)
  assert.doesNotThrow(() => new Function(script))
  assert.ok(script.includes('/__dsh-static-cache/sw.js'))
})

test('carries every worker setting', () => {
  const payload = pageScriptConfig(resolveConfig({ concurrency: 2, graceMinutes: 3, maxAgeDays: 4 }))
  assert.equal(payload.concurrency, 2)
  assert.equal(payload.graceMs, 180_000)
  assert.equal(payload.maxAgeMs, 4 * 86_400_000)
  assert.deepEqual(payload.prefixes, ['/assets/', '/plugins/'])
  assert.deepEqual(payload.exclude, ['/plugins/events'])
  assert.ok(registerScript(config).includes(JSON.stringify(pageScriptConfig(config))))
})

test('never emits a closing script tag', () => {
  const script = registerScript(config)
  assert.ok(!/<\/script/i.test(script))
})
