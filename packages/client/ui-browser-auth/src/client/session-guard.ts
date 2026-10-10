/** Confirm authentication loss before discarding recoverable application state. */
import { AuthClient } from '../public/auth-client.ts'

/** One cancellable, deduplicated session probe with an absolute session deadline. */
export class SessionGuard {
  private readonly abort = new AbortController()
  private readonly client: AuthClient
  private checking = false
  private stopped = false
  private timer: ReturnType<typeof setTimeout> | undefined
  constructor(mountPath: string, private readonly endSession: () => Promise<void>, fetcher: typeof fetch = fetch) {
    this.client = new AuthClient(mountPath, (input, init) => fetcher(input, { ...init, signal: this.abort.signal }))
  }

  /**
 * Probe authentication and discard private state only after confirmed session loss.
 * @returns after one probe; transport failures retain recoverable state.
 */
  async check(): Promise<void> {
    if (this.stopped || this.checking) return
    this.checking = true
    try {
      let state
      try { state = await this.client.refresh() } catch (_probeError) { return }
      if (this.abort.signal.aborted) return
      if (!state.authenticated) {
        this.stop()
        await this.endSession()
        return
      }
      clearTimeout(this.timer)
      if (state.expiresAt !== undefined) this.schedule(state.expiresAt)
    } finally { this.checking = false }
  }

  /** Cancel pending probes and remove deadline work with the owning plugin. */
  stop(): void { this.stopped = true; clearTimeout(this.timer); this.abort.abort() }

  private schedule(expiresAt: number): void {
    this.timer = setTimeout(() => {
      if (this.stopped) return
      if (Date.now() < expiresAt) this.schedule(expiresAt)
      else void this.check()
    }, Math.min(Math.max(0, expiresAt - Date.now()), 2147483647))
  }
}
