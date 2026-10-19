/** HTTP probes for local listeners with an explicit external Host header. */
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Buffer } from 'node:buffer'

/** Send one bounded request without following redirects; preserve Set-Cookie fields.
 * @param {string | URL} url Listener URL, independent of the configured Host.
 * @param {{ method?: string, headers?: Record<string, string>, body?: URLSearchParams }} options Request fields.
 * @returns {Promise<Response>} Buffered response from the listener.
 */
export function request(url, options) {
  return new Promise((resolve, reject) => {
    const target = new globalThis.URL(url)
    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest
    const outgoing = transport(target, {
      method: options.method ?? 'GET', headers: options.headers,
      signal: globalThis.AbortSignal.timeout(5000),
    }, incoming => {
      const chunks = []
      incoming.on('data', chunk => { chunks.push(chunk) })
      incoming.once('error', reject)
      incoming.once('end', () => {
        const headers = new globalThis.Headers()
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          headers.append(incoming.rawHeaders[index], incoming.rawHeaders[index + 1])
        }
        const status = incoming.statusCode ?? 500
        const body = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks)
        resolve(new globalThis.Response(body, { status, headers }))
      })
    })
    outgoing.once('error', reject)
    outgoing.end(options.body?.toString())
  })
}
