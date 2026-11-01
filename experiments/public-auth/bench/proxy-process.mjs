/** Host the built proxy for load generation and expose per-scenario CPU profiles. */
import { writeFileSync } from 'node:fs'
import process from 'node:process'
import { Session } from 'node:inspector/promises'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { createProxy } from '../dist/proxy.js'

const origin = process.env.PUBLIC_ORIGIN
const stateDirectory = process.env.STATE_DIR
const launchUrlFile = process.env.LAUNCH_URL_FILE
const port = Number(process.env.PROXY_PORT)
if (!origin || !stateDirectory || !launchUrlFile || !Number.isInteger(port)) {
  throw new Error('PUBLIC_ORIGIN, STATE_DIR, LAUNCH_URL_FILE, and PROXY_PORT are required')
}

const app = await createProxy({
  publicOrigin: origin,
  stateDirectory,
  launchUrlFile,
  sessionSeconds: Number(process.env.SESSION_SECONDS ?? 30 * 86400),
  loginAttempts: Number(process.env.LOGIN_ATTEMPTS ?? 5),
  loginWindowSeconds: Number(process.env.LOGIN_WINDOW_SECONDS ?? 60),
  sessionCacheSeconds: Number(process.env.SESSION_CACHE_SECONDS || '60'),
  trustedProxyIps: process.env.TRUSTED_PROXY_IPS ?? '',
})
await app.listen({ host: '127.0.0.1', port })

const inspector = new Session()
inspector.connect()
const eventLoopDelay = monitorEventLoopDelay({ resolution: 10 })
let samplingInterval = 1_000
let startedAt = performance.now()
let cpuStarted = process.cpuUsage()
let profiling = false

const millis = nanoseconds => nanoseconds / 1e6
const send = (message) => { process.send?.(message) }
const timestamp = () => performance.now()

process.on('message', async message => {
  try {
    switch (message.type) {
      case 'profile-start':
        if (samplingInterval !== message.samplingInterval) {
          samplingInterval = message.samplingInterval ?? 1_000
          await inspector.post('Profiler.enable')
          await inspector.post('Profiler.setSamplingInterval', { interval: samplingInterval })
        } else {
          await inspector.post('Profiler.enable')
        }
        eventLoopDelay.enable()
        eventLoopDelay.reset()
        startedAt = timestamp()
        cpuStarted = process.cpuUsage()
        await inspector.post('Profiler.start')
        profiling = true
        send({ type: 'profile-started', id: message.id })
        break
      case 'profile-stop': {
        if (!profiling) throw new Error('Profiler is not running')
        const { profile } = await inspector.post('Profiler.stop')
        eventLoopDelay.disable()
        profiling = false
        writeFileSync(message.path, JSON.stringify(profile))
        const cpu = process.cpuUsage(cpuStarted)
        send({
          type: 'profile-saved',
          id: message.id,
          path: message.path,
          elapsedMs: timestamp() - startedAt,
          cpuUserMs: cpu.user / 1_000,
          cpuSystemMs: cpu.system / 1_000,
          rss: process.memoryUsage.rss(),
          eventLoopMaxMs: millis(eventLoopDelay.max),
          eventLoopP99Ms: millis(eventLoopDelay.percentile(99)),
        })
        break
      }
      case 'close':
        process.removeAllListeners('message')
        await app.close()
        inspector.disconnect()
        process.disconnect()
        break
      default:
        throw new Error(`Unknown control message: ${message.type}`)
    }
  } catch (error) {
    send({ type: 'control-error', id: message.id, message: error instanceof Error ? error.message : String(error) })
  }
})

send({ type: 'ready', pid: process.pid })
