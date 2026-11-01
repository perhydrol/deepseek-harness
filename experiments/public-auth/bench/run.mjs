/** Stress and CPU-profile the built public-auth proxy against an owned upstream fixture.
 *
 * Every scenario runs the shipped dist/ code under plain Node. The load generator
 * lives in this parent process; the proxy and fixture are separate children, so
 * their CPU profiles exclude client-side and fixture work.
 */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import net from 'node:net'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { clearTimeout, setTimeout } from 'node:timers'
import { URL, URLSearchParams } from 'node:url'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import WebSocket from 'ws'
import { initialize } from '../dist/auth.js'
import { analyzeProfile, formatProfileReport } from './profile-report.mjs'

const here = fileURLToPath(new URL('.', import.meta.url))
const PASSWORD = 'bench-password-only'
const WRONG_PASSWORD = 'wrong-bench-password'
const USER_AGENT = 'public-auth-bench/1.0'

const { values } = parseArgs({
  options: {
    only: { type: 'string' },
    duration: { type: 'string', default: '5000' },
    concurrency: { type: 'string', default: '32' },
    'profile-interval': { type: 'string', default: '500' },
    'session-cache-seconds': { type: 'string', default: '60' },
    'no-profile': { type: 'boolean', default: false },
    out: { type: 'string' },
    top: { type: 'string', default: '15' },
  },
})

const durationMs = Number(values.duration)
const concurrency = Number(values.concurrency)
const profileInterval = Number(values['profile-interval'])
const top = Number(values.top)
const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d+Z$/u, 'Z')
const outDirectory = values.out ?? join(here, 'results', stamp)
const profileDirectory = join(outDirectory, 'profiles')

const builtProxy = join(here, '..', 'dist', 'proxy.js')
if (!existsSync(builtProxy)) throw new Error('Build the experiment first: pnpm build')
const sourceDirectory = join(here, '..', 'src')
const newestSource = Math.max(...readdirSync(sourceDirectory)
  .filter(name => name.endsWith('.ts'))
  .map(name => statSync(join(sourceDirectory, name)).mtimeMs))
if (statSync(builtProxy).mtimeMs < newestSource) throw new Error('dist/ is older than src/; run pnpm build')

/** Reserve a loopback port, then release it for the proxy child. */
async function freePort() {
  const server = net.createServer()
  server.unref()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('Cannot reserve a loopback port')
  await new Promise(resolve => server.close(resolve))
  return address.port
}

/** Minimal ordered IPC channel with per-message timeouts. */
function channel(child, label) {
  const queued = []
  const waiting = []
  const fail = (error) => {
    for (const entry of waiting.splice(0)) { clearTimeout(entry.timer); entry.reject(error) }
  }
  child.on('message', message => {
    const entry = waiting.shift()
    if (entry) { clearTimeout(entry.timer); entry.resolve(message) } else queued.push(message)
  })
  child.once('exit', (code, signal) => fail(new Error(`${label} exited early (code ${code}, signal ${signal})`)))
  child.once('error', fail)
  return {
    next(timeoutMs = 30_000) {
      if (queued.length > 0) return Promise.resolve(queued.shift())
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} did not answer within ${timeoutMs} ms`)), timeoutMs)
        waiting.push({ resolve, reject, timer })
      })
    },
    async request(message, expected, timeoutMs) {
      child.send(message)
      for (;;) {
        const reply = await this.next(timeoutMs)
        if (reply.type === 'control-error' && reply.id === message.id) throw new Error(`${label}: ${reply.message}`)
        if (reply.type === expected && reply.id === message.id) return reply
      }
    },
    send(message) { child.send(message) },
  }
}

async function startChild(script, env, label) {
  const child = spawn(process.execPath, [join(here, script)], {
    cwd: join(here, '..'), env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  })
  const messages = channel(child, label)
  const ready = await messages.next(30_000)
  if (ready.type !== 'ready') throw new Error(`${label} sent ${ready.type} before ready`)
  return { child, messages, ready }
}

async function stopChild(instance, { control = false } = {}) {
  const { child, messages } = instance
  if (child.exitCode !== null || child.signalCode !== null) return
  if (control) messages.send({ type: 'close' })
  else child.kill('SIGTERM')
  const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
  await once(child, 'exit').catch(() => {})
  clearTimeout(timer)
}

/** Send one HTTP request and consume the body, returning status, headers, and size. */
function request({ port, path, method = 'GET', headers, body, agent }) {
  return new Promise((resolve, reject) => {
    const outgoing = http.request({ host: '127.0.0.1', port, path, method, headers, agent }, incoming => {
      let bytes = 0
      incoming.on('data', chunk => { bytes += chunk.length })
      incoming.once('end', () => resolve({
        status: incoming.statusCode ?? 0, headers: incoming.headers, bytes,
      }))
      incoming.once('error', reject)
    })
    outgoing.setTimeout(15_000, () => outgoing.destroy(new Error('request timed out')))
    outgoing.once('error', reject)
    outgoing.end(body)
  })
}

const percentile = (sorted, fraction) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))] ?? 0

/** Aggregate one scenario's latency and status observations. */
function summarize(samples, elapsedMs, errors, statuses, bytes) {
  const latency = samples.flat().sort((left, right) => left - right)
  return {
    requests: latency.length,
    elapsedMs: Math.round(elapsedMs),
    rps: latency.length / (elapsedMs / 1_000),
    meanMs: latency.reduce((sum, value) => sum + value, 0) / Math.max(1, latency.length),
    p50Ms: percentile(latency, 0.50),
    p90Ms: percentile(latency, 0.90),
    p99Ms: percentile(latency, 0.99),
    maxMs: latency[latency.length - 1] ?? 0,
    errors,
    statuses: Object.fromEntries([...statuses.entries()].sort(([left], [right]) => left - right)),
    bytes,
  }
}

function formatSummary(result) {
  const status = Object.entries(result.statuses).map(([code, count]) => `${code}:${count}`).join(' ')
  return `${result.requests} req in ${result.elapsedMs} ms = ${result.rps.toFixed(0)} req/s`
    + ` | p50 ${result.p50Ms.toFixed(2)} p90 ${result.p90Ms.toFixed(2)} p99 ${result.p99Ms.toFixed(2)} max ${result.maxMs.toFixed(1)} ms`
    + ` | ${(result.bytes / 1024 / 1024).toFixed(1)} MiB | errors ${result.errors} | ${status}`
}

/** Reject a promise that does not settle within the deadline. */
function withTimeout(promise, milliseconds, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(label)), milliseconds)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error) },
    )
  })
}

/** Run a closed-loop HTTP workload; each worker keeps one keep-alive connection busy. */
async function httpLoad({ port, path, headers, concurrency: workers, durationMs: runFor, method = 'GET', body }) {
  const agent = new http.Agent({ keepAlive: true, maxSockets: workers })
  const samples = []
  const statuses = new Map()
  let errors = 0
  let bytes = 0
  const started = performance.now()
  const deadline = started + runFor
  await Promise.all(Array.from({ length: workers }, async () => {
    const local = []
    while (performance.now() < deadline) {
      const begin = performance.now()
      try {
        const response = await request({ port, path, method, headers, body, agent })
        local.push(performance.now() - begin)
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1)
        bytes += response.bytes
      } catch {
        errors++
      }
    }
    samples.push(local)
  }))
  agent.destroy()
  return summarize(samples, performance.now() - started, errors, statuses, bytes)
}

/** Measure WebSocket handshakes against the authenticated proxy. */
async function wsConnectLoad({ url, headers, total, concurrency: workers }) {
  const samples = []
  const statuses = new Map()
  let errors = 0
  const started = performance.now()
  let issued = 0
  await Promise.all(Array.from({ length: workers }, async () => {
    const local = []
    while (issued < total) {
      issued++
      const begin = performance.now()
      try {
        const socket = new WebSocket(url, { headers, handshakeTimeout: 10_000 })
        const opened = new Promise((resolve, reject) => {
          socket.once('open', resolve)
          socket.once('error', reject)
          socket.once('unexpected-response', (_request, response) => {
            response.resume()
            statuses.set(response.statusCode ?? 0, (statuses.get(response.statusCode ?? 0) ?? 0) + 1)
            socket.terminate()
            reject(new Error(`WebSocket handshake returned ${response.statusCode}`))
          })
        })
        await withTimeout(opened, 15_000, 'WebSocket handshake timed out')
        local.push(performance.now() - begin)
        statuses.set(101, (statuses.get(101) ?? 0) + 1)
        const closed = once(socket, 'close')
        socket.close()
        await withTimeout(closed, 10_000, 'WebSocket close timed out').catch(() => {})
      } catch {
        errors++
      }
    }
    samples.push(local)
  }))
  return summarize(samples, performance.now() - started, errors, statuses, 0)
}

/** Measure request/echo round trips over established authenticated sockets. */
async function wsEchoLoad({ url, headers, sockets, messages }) {
  const samples = []
  let errors = 0
  const started = performance.now()
  await Promise.all(Array.from({ length: sockets }, async () => {
    const local = []
    let socket
    try {
      socket = new WebSocket(url, { headers, handshakeTimeout: 10_000 })
      await withTimeout(once(socket, 'open'), 15_000, 'WebSocket handshake timed out')
      for (let index = 0; index < messages; index++) {
        const begin = performance.now()
        const echoed = once(socket, 'message')
        socket.send(`benchmark-${index}`)
        await withTimeout(echoed, 15_000, 'WebSocket echo timed out')
        local.push(performance.now() - begin)
      }
    } catch {
      errors++
    } finally {
      if (socket && socket.readyState === WebSocket.OPEN) {
        const closed = once(socket, 'close')
        socket.close()
        await withTimeout(closed, 10_000, 'WebSocket close timed out').catch(() => {})
      }
    }
    samples.push(local)
  }))
  const result = summarize(samples, performance.now() - started, errors, new Map(), 0)
  result.requests = samples.reduce((sum, local) => sum + local.length, 0)
  return result
}

/** Attempt logins from distinct client IPs so the per-IP budget does not mask hashing cost. */
async function loginLoad({ port, origin, attempts }) {
  const samples = []
  const statuses = new Map()
  let errors = 0
  let next = 0
  const started = performance.now()
  await Promise.all(Array.from({ length: 4 }, async () => {
    const local = []
    while (next < attempts) {
      const index = next++
      const begin = performance.now()
      try {
        const response = await request({
          port, path: '/_auth/login', method: 'POST',
          headers: {
            host: new URL(origin).host, origin,
            'content-type': 'application/x-www-form-urlencoded',
            'x-forwarded-for': `203.0.113.${index + 1}`,
            'user-agent': USER_AGENT,
          },
          body: new URLSearchParams({ password: WRONG_PASSWORD }).toString(),
        })
        local.push(performance.now() - begin)
        statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1)
      } catch {
        errors++
      }
    }
    samples.push(local)
  }))
  const result = summarize(samples, performance.now() - started, errors, statuses, 0)
  result.notes = 'Wrong password from a unique client IP per attempt; measures password verification and rate-limit writes.'
  return result
}

const authenticated = ctx => httpLoad({
  port: ctx.port, path: '/api/session', headers: ctx.headers, concurrency, durationMs: ctx.durationMs,
})
const sessionCheck = ctx => httpLoad({
  port: ctx.port, path: '/_auth/session', headers: ctx.headers, concurrency, durationMs: ctx.durationMs,
})
const documentGet = ctx => httpLoad({
  port: ctx.port, path: '/', headers: ctx.headers, concurrency, durationMs: ctx.durationMs,
})
const assetJs = ctx => httpLoad({
  port: ctx.port, path: '/assets/index-CN7NIWNw.js', headers: ctx.headers, concurrency: Math.max(4, Math.floor(concurrency / 2)), durationMs: ctx.durationMs,
})
const anonymousGet = ctx => httpLoad({
  port: ctx.port, path: '/api/session', headers: ctx.anonymousHeaders, concurrency, durationMs: ctx.durationMs,
})

const scenarios = new Map([
  ['api-get', { profile: true, run: authenticated, warmup: ctx => authenticated({ ...ctx, durationMs: 800 }) }],
  ['session-check', { profile: true, run: sessionCheck, warmup: ctx => sessionCheck({ ...ctx, durationMs: 800 }) }],
  ['document-get', { profile: true, run: documentGet, warmup: ctx => documentGet({ ...ctx, durationMs: 800 }) }],
  ['asset-js', { profile: true, run: assetJs, warmup: ctx => assetJs({ ...ctx, durationMs: 800 }) }],
  ['anonymous-get', { profile: true, run: anonymousGet, warmup: ctx => anonymousGet({ ...ctx, durationMs: 800 }) }],
  ['login', {
    profile: true,
    run: ctx => loginLoad({ port: ctx.port, origin: ctx.origin, attempts: 24 }),
    warmup: ctx => loginLoad({ port: ctx.port, origin: ctx.origin, attempts: 2 }),
  }],
  ['ws-connect', {
    profile: true,
    run: ctx => wsConnectLoad({ url: ctx.wsUrl, headers: ctx.wsHeaders, total: 300, concurrency: 16 }),
    warmup: ctx => wsConnectLoad({ url: ctx.wsUrl, headers: ctx.wsHeaders, total: 20, concurrency: 8 }),
  }],
  ['ws-echo', {
    profile: true,
    run: ctx => wsEchoLoad({ url: ctx.wsUrl, headers: ctx.wsHeaders, sockets: 32, messages: 200 }),
    warmup: ctx => wsEchoLoad({ url: ctx.wsUrl, headers: ctx.wsHeaders, sockets: 8, messages: 5 }),
  }],
])

/** Establish one authenticated browser session through the public login endpoint. */
async function login(port, origin, ip) {
  const response = await request({
    port, path: '/_auth/login', method: 'POST',
    headers: {
      host: new URL(origin).host, origin,
      'content-type': 'application/x-www-form-urlencoded',
      'x-forwarded-for': ip, 'user-agent': USER_AGENT,
    },
    body: new URLSearchParams({ password: PASSWORD }).toString(),
  })
  if (response.status !== 303) throw new Error(`Login returned ${response.status}`)
  const cookies = response.headers['set-cookie'] ?? []
  const credential = cookies.find(value => value.includes('dsh-proxy-local='))
  if (!credential) throw new Error('Login did not issue the local session cookie')
  return credential.split(';')[0]
}

/** Prove the measured paths are the real authenticated, anonymous, and redirect paths. */
async function verify(port, origin, credential) {
  const host = new URL(origin).host
  const checks = []
  const session = await request({ port, path: '/api/session', headers: {
    host, origin, cookie: credential, 'user-agent': USER_AGENT, 'x-forwarded-for': '198.51.100.7',
  } })
  checks.push([session.status === 200 && session.headers['cache-control'] === 'no-store', 'authenticated GET /api/session'])
  const asset = await request({ port, path: '/assets/index-CN7NIWNw.js', headers: {
    host, origin, cookie: credential, 'user-agent': USER_AGENT, 'x-forwarded-for': '198.51.100.7',
  } })
  checks.push([asset.status === 200 && asset.headers['cache-control'] === 'private, max-age=31536000, immutable', 'hashed asset caching'])
  const anonymous = await request({ port, path: '/api/session', headers: {
    host, 'user-agent': USER_AGENT, 'x-forwarded-for': '198.51.100.7',
  } })
  checks.push([anonymous.status === 401, 'anonymous GET refused'])
  const document = await request({ port, path: '/', headers: {
    host, 'user-agent': USER_AGENT, 'x-forwarded-for': '198.51.100.7', 'sec-fetch-dest': 'document',
  } })
  checks.push([document.status === 303 && document.headers.location === '/_auth/login', 'document redirect'])
  const failed = checks.filter(([ok]) => !ok).map(([, name]) => name)
  if (failed.length > 0) throw new Error(`Endpoint verification failed: ${failed.join(', ')}`)
  return checks.map(([, name]) => name)
}

const report = []
const summary = {
  startedAt: new Date().toISOString(),
  node: process.version,
  platform: process.platform,
  arch: process.arch,
  cpus: cpus().length,
  durationMs,
  concurrency,
  profileInterval,
  scenarios: {},
  profiles: {},
}

await mkdir(profileDirectory, { recursive: true })
const directory = await mkdtemp(join(tmpdir(), 'dsh-auth-bench-'))
const launchUrlFile = join(directory, 'launch-url.txt')
const proxyPort = await freePort()
const origin = `http://127.0.0.1:${proxyPort}`
let upstream
let proxy
try {
  await initialize(directory, PASSWORD)
  upstream = await startChild('upstream.mjs', {}, 'upstream')
  const upstreamPort = upstream.ready.port
  await writeFile(launchUrlFile, `http://127.0.0.1:${upstreamPort}/?token=private-token\n`)
  proxy = await startChild('proxy-process.mjs', {
    PUBLIC_ORIGIN: origin,
    STATE_DIR: directory,
    LAUNCH_URL_FILE: launchUrlFile,
    PROXY_PORT: String(proxyPort),
    TRUSTED_PROXY_IPS: '127.0.0.1',
    SESSION_SECONDS: String(30 * 86400),
    SESSION_CACHE_SECONDS: values['session-cache-seconds'],
  }, 'proxy')

  const credential = await login(proxyPort, origin, '198.51.100.7')
  const verified = await verify(proxyPort, origin, credential)
  const host = new URL(origin).host
  const context = {
    port: proxyPort,
    origin,
    wsUrl: `ws://127.0.0.1:${proxyPort}/api/remote.mux`,
    durationMs,
    headers: { host, origin, cookie: credential, 'user-agent': USER_AGENT, 'x-forwarded-for': '198.51.100.7' },
    anonymousHeaders: { host, 'user-agent': USER_AGENT, 'x-forwarded-for': '198.51.100.7' },
  }
  context.wsHeaders = { ...context.headers, origin }

  report.push(`public-auth stress profile | node ${process.version} | ${summary.platform}/${summary.arch} | ${summary.cpus} cpus`)
  report.push(`proxy ${origin} -> fixture http://127.0.0.1:${upstreamPort} | duration ${durationMs} ms | concurrency ${concurrency}`)
  report.push(`verified paths: ${verified.join(', ')}`)
  report.push('')

  const selected = values.only ? new Set(values.only.split(',').map(name => name.trim())) : undefined
  for (const [name, definition] of scenarios) {
    if (selected && !selected.has(name)) continue
    const entry = { measurements: [], profile: undefined }
    report.push(`== ${name} ==`)
    await definition.warmup(context)
    for (let round = 0; round < 2; round++) {
      const result = await definition.run(context)
      entry.measurements.push(result)
      report.push(`run ${round + 1}: ${formatSummary(result)}`)
      if (result.notes) report.push(`  note: ${result.notes}`)
    }
    summary.scenarios[name] = entry

    if (definition.profile && !values['no-profile']) {
      const id = `${name}-${Date.now()}`
      const profilePath = join(profileDirectory, `${name}.cpuprofile`)
      await proxy.messages.request({ type: 'profile-start', id, samplingInterval: profileInterval }, 'profile-started', 30_000)
      const profiled = await definition.run(context)
      const saved = await proxy.messages.request({ type: 'profile-stop', id, path: profilePath }, 'profile-saved', 60_000)
      const analysis = analyzeProfile(JSON.parse(await readFile(profilePath, 'utf8')))
      entry.profile = { stats: saved, workload: profiled, analysis }
      summary.profiles[name] = {
        path: profilePath,
        stats: saved,
        workload: profiled,
        durationMs: analysis.durationMs,
        idleMs: analysis.idleMs,
        gcMs: analysis.gcMs,
        busyMs: analysis.busyMs,
        categories: analysis.categories,
        attributed: analysis.attributed,
        hotFrames: analysis.top.slice(0, top * 2),
        hotScripts: analysis.files.slice(0, 12),
      }
      report.push(`profile run: ${formatSummary(profiled)}`)
      report.push(`cpu ${saved.cpuUserMs.toFixed(0)} user + ${saved.cpuSystemMs.toFixed(0)} system ms, rss ${(saved.rss / 1024 / 1024).toFixed(0)} MiB, event-loop max ${saved.eventLoopMaxMs.toFixed(1)} ms p99 ${saved.eventLoopP99Ms.toFixed(1)} ms`)
      report.push(formatProfileReport(analysis, { top, sampleLabel: name }))
    }
    report.push('')
  }
} finally {
  if (proxy) await stopChild(proxy, { control: true }).catch(() => {})
  if (upstream) await stopChild(upstream, { control: true }).catch(() => {})
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
}

summary.finishedAt = new Date().toISOString()
await writeFile(join(outDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
await writeFile(join(outDirectory, 'report.txt'), `${report.join('\n')}\n`)
process.stdout.write(`${report.join('\n')}\n\nresults: ${outDirectory}\n`)
