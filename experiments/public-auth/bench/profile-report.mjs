/** Summarize a V8 .cpuprofile into self-time hot spots and owner packages. */
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

const IDLE = '(idle)'
const GC = '(garbage collector)'

/** Classify a V8 script URL into the dependency that owns the sampled code. */
export function categorize(url) {
  if (!url) return 'native'
  if (url.startsWith('node:inspector')) return 'profiler'
  if (url.includes('node:internal') || url.includes('/node:internal/')) return 'node'
  if (url.includes('node:sqlite') || url.includes('/sqlite')) return 'sqlite'
  if (url.includes('better-auth') || url.includes('@better-auth')) return 'better-auth'
  if (url.includes('@fastify') || url.includes('/fastify/')) return 'fastify'
  if (url.includes('/public-auth/dist/')) return 'proxy'
  if (url.includes('/ws/')) return 'ws'
  if (url.includes('node_modules')) return 'dependencies'
  return 'other'
}

/** Aggregate self time per call frame and attribute native frames to their JS owner.
 * Idle, GC, and profiler frames are counted separately and excluded from the busy tables.
 * @param {object} profile Parsed V8 CPU profile.
 * @returns {{durationMs: number, sampledMs: number, idleMs: number, gcMs: number, profilerMs: number, busyMs: number, top: object[], categories: object[], attributed: object[], files: object[]}}
 */
export function analyzeProfile(profile) {
  const byId = new Map(profile.nodes.map(node => [node.id, node]))
  const parent = new Map()
  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parent.set(child, node.id)
  }
  const ownerCache = new Map()
  const ownerFrame = (id) => {
    const cached = ownerCache.get(id)
    if (cached !== undefined) return cached
    let current = id
    let found = null
    while (current !== undefined) {
      const node = byId.get(current)
      if (node.callFrame.url) { found = node.callFrame; break }
      current = parent.get(current)
    }
    ownerCache.set(id, found)
    return found
  }
  const self = new Map()
  const total = profile.samples.reduce((sum, id, index) => {
    const delta = profile.timeDeltas[index] ?? 0
    if (!byId.has(id)) return sum
    self.set(id, (self.get(id) ?? 0) + delta)
    return sum + delta
  }, 0)
  const frames = new Map()
  const categories = new Map()
  const attributed = new Map()
  const files = new Map()
  let idleMs = 0
  let gcMs = 0
  let profilerMs = 0
  for (const [id, microseconds] of self) {
    const frame = byId.get(id).callFrame
    const name = frame.functionName || '(anonymous)'
    const file = frame.url || ''
    const milliseconds = microseconds / 1_000
    if (name === IDLE) { idleMs += milliseconds; continue }
    if (name === GC) { gcMs += milliseconds; continue }
    const owner = ownerFrame(id)
    const ownerCategory = owner === null ? 'native' : categorize(owner.url)
    if (ownerCategory === 'profiler' || file.startsWith('node:inspector')) { profilerMs += milliseconds; continue }
    const key = `${name}\u0000${file}\u0000${frame.lineNumber}`
    const entry = frames.get(key) ?? { name, file, line: frame.lineNumber + 1, milliseconds: 0, owners: new Map() }
    entry.milliseconds += milliseconds
    entry.owners.set(ownerCategory, (entry.owners.get(ownerCategory) ?? 0) + milliseconds)
    frames.set(key, entry)
    const category = categorize(file)
    categories.set(category, (categories.get(category) ?? 0) + milliseconds)
    attributed.set(ownerCategory, (attributed.get(ownerCategory) ?? 0) + milliseconds)
    const fileKey = file || '(native)'
    files.set(fileKey, (files.get(fileKey) ?? 0) + milliseconds)
  }
  const rank = (map) => [...map.entries()]
    .map(([name, milliseconds]) => ({ name, milliseconds }))
    .sort((left, right) => right.milliseconds - left.milliseconds)
  const top = [...frames.values()].filter(frame => frame.name !== IDLE && frame.name !== GC)
    .map(frame => ({ ...frame, owner: [...frame.owners.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? 'native' }))
    .sort((left, right) => right.milliseconds - left.milliseconds)
  return {
    durationMs: (profile.endTime - profile.startTime) / 1_000,
    sampledMs: total / 1_000,
    idleMs,
    gcMs,
    profilerMs,
    busyMs: Math.max(0, total / 1_000 - idleMs - gcMs - profilerMs),
    top,
    categories: rank(categories),
    attributed: rank(attributed),
    files: rank(files).map(({ name, milliseconds }) => ({ file: name, milliseconds })),
  }
}

const percent = (part, whole) => whole === 0 ? '0.0%' : `${(part / whole * 100).toFixed(1)}%`

/** Render the hot-spot summary as terminal-friendly text. */
export function formatProfileReport(result, { top = 20, sampleLabel = '' } = {}) {
  const busy = result.busyMs
  const lines = [
    `profile ${sampleLabel}`.trim(),
    `duration ${result.durationMs.toFixed(0)} ms, sampled ${result.sampledMs.toFixed(0)} ms, busy ${busy.toFixed(0)} ms, idle ${result.idleMs.toFixed(0)} ms, gc ${result.gcMs.toFixed(0)} ms, profiler ${result.profilerMs.toFixed(0)} ms; shares use busy time`,
    '',
    'attributed owner         self ms    share',
  ]
  for (const entry of result.attributed) {
    lines.push(`${entry.name.padEnd(24)}${entry.milliseconds.toFixed(0).padStart(8)}  ${percent(entry.milliseconds, busy).padStart(6)}`)
  }
  lines.push('', 'raw frames               self ms    share')
  for (const entry of result.categories) {
    lines.push(`${entry.name.padEnd(24)}${entry.milliseconds.toFixed(0).padStart(8)}  ${percent(entry.milliseconds, busy).padStart(6)}`)
  }
  lines.push('', 'hot call frames')
  for (const frame of result.top.slice(0, top)) {
    const location = frame.file ? `${frame.file}:${frame.line}` : '(native)'
    lines.push(`${frame.milliseconds.toFixed(0).padStart(7)} ms ${percent(frame.milliseconds, busy).padStart(6)} [${frame.owner}]  ${frame.name}  ${location}`)
  }
  lines.push('', 'hot scripts')
  for (const file of result.files.slice(0, Math.min(top, 12))) {
    lines.push(`${file.milliseconds.toFixed(0).padStart(7)} ms ${percent(file.milliseconds, busy).padStart(6)}  ${file.file}`)
  }
  return lines.join('\n')
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [file, option] = process.argv.slice(2)
  if (!file) throw new Error('Usage: node bench/profile-report.mjs PROFILE.cpuprofile [--top N]')
  const top = option?.startsWith('--top=') ? Number(option.slice(6)) : 20
  process.stdout.write(`${formatProfileReport(analyzeProfile(JSON.parse(readFileSync(file, 'utf8'))), { top })}\n`)
}
