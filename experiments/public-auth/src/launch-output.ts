/** Capture the official CLI readiness line without publishing its bearer token. */
import { renameSync, writeFileSync } from 'node:fs'
import { Writable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { StringDecoder } from 'node:string_decoder'

/** Create separate line buffers for stdout and stderr, sharing one private URL file.
 * @param file Private URL destination in an owner-only directory.
 * @param origin Exact loopback origin expected from the CLI.
 * @param log Receives redacted lines, including unterminated final lines.
 * @returns Writable streams and a completion promise that rejects on capture failure.
 */
export function createLaunchOutput(file: string, origin: string, log: (line: string) => void) {
  const consume = (line: string): void => {
    const ready = /^dsh web: (\S+)\s*$/u.exec(line)
    if (ready?.[1]) {
      const url = new URL(ready[1])
      if (url.origin === origin && url.pathname === '/' && !url.username && !url.password
        && !url.hash && url.searchParams.size === 1 && url.searchParams.get('token')) {
        writeFileSync(`${file}.next`, `${url.href}\n`, { mode: 0o600 })
        renameSync(`${file}.next`, file)
      }
    }
    log(`${line.replace(/([?&]token=)[^\s&#]*/giu, '$1[redacted]')}\n`)
  }
  const stream = (): Writable => {
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        try {
          buffer += decoder.write(chunk)
          let end: number
          while ((end = buffer.indexOf('\n')) !== -1) {
            consume(buffer.slice(0, end).replace(/\r$/u, ''))
            buffer = buffer.slice(end + 1)
          }
          if (buffer.length > 1_048_576) throw new Error('DSH emitted an oversized output line')
          callback()
        } catch { callback(new Error('Cannot capture private DSH startup output')) }
      },
      final(callback) {
        try {
          buffer += decoder.end()
          if (buffer) consume(buffer)
          callback()
        } catch { callback(new Error('Cannot capture private DSH startup output')) }
      },
    })
  }
  const stdout = stream()
  const stderr = stream()
  return { stdout, stderr, finished: async () => { await Promise.all([finished(stdout), finished(stderr)]) } }
}
