/** Probe both supervised services without printing private startup credentials. */
import { readFile } from 'node:fs/promises'

try {
  const origin = new URL(process.env.PUBLIC_ORIGIN ?? '')
  const response = await fetch('http://127.0.0.1:8080/_auth/login', {
    headers: { host: origin.host }, signal: AbortSignal.timeout(2000),
  })
  await response.body?.cancel()
  if (response.status !== 200) throw new Error('Proxy unavailable')
  const url = new URL((await readFile('/run/dsh/launch-url', 'utf8')).trim())
  if (url.origin !== 'http://127.0.0.1:3081') throw new Error('Unexpected upstream')
  const upstream = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(2000) })
  await upstream.body?.cancel()
  if (upstream.status !== 303) throw new Error('DSH unavailable')
} catch { process.exitCode = 1 }
