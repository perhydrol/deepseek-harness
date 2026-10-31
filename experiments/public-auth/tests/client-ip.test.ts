/** Forwarded addresses are accepted only from explicitly trusted socket peers. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createClientIpResolver } from '../src/client-ip.ts'

test('untrusted peers cannot change their address through forwarding headers', () => {
  const resolve = createClientIpResolver('192.0.2.1')
  assert.equal(resolve('192.0.2.2', '198.51.100.1'), '192.0.2.2')
  assert.equal(createClientIpResolver()('192.0.2.1', '198.51.100.1'), '192.0.2.1')
  assert.equal(createClientIpResolver()('fe80::1%eth0', undefined), 'fe80::1%eth0')
})

test('trusted peers must supply exactly one valid client IP', () => {
  const resolve = createClientIpResolver('192.0.2.1, 2001:db8::1')
  assert.equal(resolve('::ffff:192.0.2.1', '198.51.100.1'), '198.51.100.1')
  assert.equal(resolve('::ffff:c000:201', '::ffff:c633:6401'), '198.51.100.1')
  assert.equal(resolve('2001:0db8:0:0:0:0:0:1', '2001:db8::2'), '2001:db8::2')
  for (const header of [undefined, '', 'garbage', 'fe80::1%eth0', ['198.51.100.1'], '198.51.100.1, 198.51.100.2']) {
    assert.throws(() => resolve('192.0.2.1', header), { statusCode: 400 })
  }
})

test('invalid trust configuration fails before serving requests', () => {
  for (const config of ['true', '*', '192.0.2.0/24', '192.0.2.1,', 'localhost', 'fe80::1%eth0']) {
    assert.throws(() => createClientIpResolver(config), /TRUSTED_PROXY_IPS/)
  }
})
