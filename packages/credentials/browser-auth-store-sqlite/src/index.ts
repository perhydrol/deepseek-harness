/** Private SQLite provider for single-operator browser authentication. */
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { openAuthStore } from './database.ts'
import type { SqliteAuthStore } from './database.ts'

/** Authentication store plugin identity. */
export const name = 'browser-auth-store-sqlite'
/** Absolute private database location. */
export interface Config {
  /** Absolute canonical location of the private authentication SQLite file. */
  path: string
}
/** Required deployment-owned database path. */
export const Config: z<Config> = z.object({ path: z.string().required() })

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Exclusively owned initialized authentication data. */
    browserAuthStore: BrowserAuthStoreService
  }
}

/** Store provider retains ownership until dependent authentication work drains. */
export class BrowserAuthStoreService extends Service {
  /**
 * @param ctx - owning context.
 * @param store - exclusive initialized SQLite owner.
 */
  constructor(ctx: Context, readonly store: SqliteAuthStore) {
    super(ctx, 'browserAuthStore')
    ctx.effect(() => () => store.close(), 'browser-auth-store-sqlite: owner')
  }
}

/**
 * Open initialized data before accepting browser authentication.
 * *
 * @param ctx - provider context.
 * *
 * @param config - private Linux database path.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  const store = await openAuthStore({ path: config.path, mode: 'open' })
  new BrowserAuthStoreService(ctx, store)
}
export { openAuthStore } from './database.ts'
