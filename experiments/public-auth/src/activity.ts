/** Process-local authentication activity; window records never contain session credentials. */
import { createHash } from 'node:crypto'

/** Fixed ten-minute reporting window and inactivity threshold, in milliseconds. */
export const ACTIVITY_WINDOW_MS = 600_000

/** One first-seen or returning authenticated session in the current window. */
export interface ActivityRecord {
  time: string
  session: string
  ip: string
  userAgent: string
}

/** Create isolated activity state. Open WebSockets count as continuous activity.
 * @param now Clock in milliseconds since the Unix epoch.
 * @returns Activity operations; snapshots are detached copies and sweep removes idle state.
 */
export function createActivity(now: () => number = Date.now) {
  const sessions = new Map<string, { lastSeen: number; sockets: number }>()
  let window = Math.floor(now() / ACTIVITY_WINDOW_MS)
  let records: ActivityRecord[] = []
  const sweep = () => {
    const time = now()
    const current = Math.floor(time / ACTIVITY_WINDOW_MS)
    if (current !== window) { window = current; records = [] }
    for (const [id, state] of sessions) {
      if (state.sockets === 0 && time - state.lastSeen > ACTIVITY_WINDOW_MS) sessions.delete(id)
    }
  }
  return {
    sweep,
    observe(id: string, ip: string, userAgent: string): void {
      const time = now()
      if (Math.floor(time / ACTIVITY_WINDOW_MS) !== window) sweep()
      const state = sessions.get(id)
      if (!state || (state.sockets === 0 && time - state.lastSeen > ACTIVITY_WINDOW_MS)) {
        records.push({ time: new Date(time).toISOString(), session: createHash('sha256').update(id).digest('hex'), ip, userAgent })
      }
      if (state) state.lastSeen = time
      else sessions.set(id, { lastSeen: time, sockets: 0 })
    },
    connect(id: string): void {
      const state = sessions.get(id)
      if (state) state.sockets++
    },
    disconnect(id: string): void {
      const state = sessions.get(id)
      if (state) { state.sockets--; state.lastSeen = now() }
    },
    snapshot(): { windowStart: string; windowEnd: string; records: ActivityRecord[] } {
      if (Math.floor(now() / ACTIVITY_WINDOW_MS) !== window) sweep()
      return {
        windowStart: new Date(window * ACTIVITY_WINDOW_MS).toISOString(),
        windowEnd: new Date((window + 1) * ACTIVITY_WINDOW_MS).toISOString(),
        records: records.map(record => ({ ...record })),
      }
    },
  }
}
