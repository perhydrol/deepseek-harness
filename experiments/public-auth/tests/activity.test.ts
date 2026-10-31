/** Instance-local clocks exercise activity windows without waiting or global timer changes. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createActivity } from '../src/activity.ts'

const WINDOW = 600_000

test('windows discard records while continuing sessions stay excluded', () => {
  let now = 0
  const activity = createActivity(() => now)
  activity.observe('session-a', '127.0.0.1', 'browser')
  const first = activity.snapshot()
  assert.equal(first.records.length, 1)
  assert.equal(first.records[0]?.ip, '127.0.0.1')
  assert.equal(first.records[0]?.userAgent, 'browser')
  assert.ok(!JSON.stringify(first).includes('session-a'))
  now = WINDOW - 1
  activity.observe('session-a', '127.0.0.1', 'browser')
  now = WINDOW
  activity.observe('session-a', '127.0.0.1', 'browser')
  assert.equal(activity.snapshot().records.length, 0)
  now += WINDOW
  activity.observe('session-a', '127.0.0.1', 'browser')
  assert.equal(activity.snapshot().records.length, 0)
  now += WINDOW + 1
  activity.observe('session-a', '127.0.0.1', 'browser')
  assert.equal(activity.snapshot().records.length, 1)
  assert.equal(activity.snapshot().records[0]?.session, first.records[0]?.session)
})

test('open sockets remain active and idle time starts at the last socket close', () => {
  let now = 0
  const activity = createActivity(() => now)
  activity.observe('a', 'ip', '')
  activity.connect('a')
  activity.connect('a')
  now = WINDOW * 3
  activity.sweep()
  activity.observe('a', 'ip', '')
  assert.equal(activity.snapshot().records.length, 0)
  activity.disconnect('a')
  now += WINDOW * 3
  activity.observe('a', 'ip', '')
  assert.equal(activity.snapshot().records.length, 0)
  activity.disconnect('a')
  now += WINDOW
  activity.observe('a', 'ip', '')
  assert.equal(activity.snapshot().records.length, 0)
  now += WINDOW + 1
  activity.sweep()
  activity.observe('a', 'ip', '')
  assert.equal(activity.snapshot().records.length, 1)
})

test('snapshots cannot mutate retained records and instances do not share state', () => {
  const activity = createActivity(() => 0)
  activity.observe('a', 'ip', 'browser')
  const snapshot = activity.snapshot()
  snapshot.records[0]!.ip = 'changed'
  snapshot.records.length = 0
  assert.equal(activity.snapshot().records[0]?.ip, 'ip')
  assert.equal(createActivity(() => 0).snapshot().records.length, 0)
})
