/** Signed launch cookies carry independently revocable admission lifetimes. */
import { describe, expect, it } from 'vitest'
import { BrowserAuth } from '../src/launch-token.ts'
import { RecordCredentials } from '../../../client/connection/tests/browser-credentials.ts'

describe('launch provider admission', () => {
  it('keeps cookie identity stable and aborts admissions on unload', async () => {
    const auth = await BrowserAuth.create({}, new RecordCredentials(), 30)
    const url = new URL(auth.authenticatedUrl('http://localhost:3080/'))
    let cookie = ''
    auth.authorizeIndex({ headers: { host: url.host }, method: 'GET', url: url.pathname + url.search }, {
      writeHead(_status, headers) { cookie = headers?.['set-cookie']?.split(';')[0] ?? '' },
      end() {},
    })
    const request = { headers: { host: url.host, cookie }, method: 'GET', url: '/', remoteAddress: '127.0.0.1' }
    const first = auth.authenticate(request)
    const next = auth.authenticate(request)
    expect(first.kind).toBe('authenticated')
    if (first.kind !== 'authenticated' || next.kind !== 'authenticated') throw new Error('cookie was refused')
    expect(next.lifetime.sessionId).toBe(first.lifetime.sessionId)
    expect(first.lifetime.revoked.aborted).toBe(false)
    auth.dispose()
    expect(first.lifetime.revoked.aborted).toBe(true)
    expect(auth.authenticate(request)).toEqual({ kind: 'rejected', status: 401 })
  })
})
