/** Exclusive synchronous SQLite authentication transactions with fail-closed publication. */
import { DatabaseSync } from 'node:sqlite'
import { fsyncSync, constants, lstatSync, openSync, closeSync, statfsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { AuthError, parseAuthState } from '@hydrogen/dsh-browser-auth'
import type { AuthState, AuthStore } from '@hydrogen/dsh-browser-auth'
import { AuthOwnership } from './ownership.ts'
import { assertAuthStoragePlatform } from './platform.ts'

/** Offline initialization or opening an existing initialized database. */
export interface OpenAuthStoreOptions {
  readonly path: string
  readonly mode: 'initialize' | 'open'
}

/** SQLite owner; successful commits publish one immutable revision synchronously. */
export class SqliteAuthStore implements AuthStore<AuthState> {
  private readonly failure = new AbortController()
  private readonly listeners = new Set<(state: Readonly<AuthState>) => void>()
  private snapshot: Readonly<AuthState> | undefined
  private updating = false
  private closed = false
  private readonly identity: string

  /**
 * @param db - exclusively owned initialized SQLite handle.
 * @param owner - held Linux flock.
 * @param path - database path.
 */
  constructor(private readonly db: DatabaseSync, private readonly owner: AuthOwnership, private readonly path: string) {
    this.identity = fileIdentity(path)
    const row = db.prepare('SELECT document FROM auth_state WHERE singleton = 1').get()
    if (row !== undefined) {
      if (typeof row.document !== 'string') throw new AuthError('auth/storage', 'Authentication state is malformed.')
      this.snapshot = freezeState(parseAuthState(JSON.parse(row.document)))
    }
  }

  get unavailable(): AbortSignal { return this.failure.signal }

  read(): Readonly<AuthState> | undefined {
    this.assertAvailable()
    return this.snapshot
  }

  update(transform: (current: Readonly<AuthState> | undefined) => AuthState): Readonly<AuthState> {
    this.assertAvailable()
    if (this.updating) throw new AuthError('auth/storage', 'Nested authentication transactions are forbidden.')
    this.updating = true
    try {
      const candidate = transform(this.snapshot)
      const next = freezeState(parseAuthState({ ...candidate, revision: (this.snapshot?.revision ?? 0) + 1 }))
      this.assertAvailable()
      try {
        this.db.exec('BEGIN IMMEDIATE')
        this.db.prepare('INSERT INTO auth_state (singleton, document) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET document = excluded.document')
          .run(JSON.stringify(next))
        this.db.exec('COMMIT')
      } catch (error) {
        this.failure.abort(error)
        throw new AuthError('auth/storage', 'Authentication commit failed; its outcome is unknown. Stop the Host and recover offline.', { cause: error })
      }
      this.snapshot = next
      try {
        for (const listener of this.listeners) listener(next)
      } catch (error) {
        this.failure.abort(error)
        throw new AuthError('auth/storage', 'Committed authentication state could not be published; restart the Host before continuing.', { cause: error })
      }
      return next
    } finally { this.updating = false }
  }

  subscribe(listener: (committed: Readonly<AuthState>) => void): () => void {
    this.assertAvailable()
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
 * Read the active SQLite durability settings.
 * @returns verified SQLite durability settings for diagnostics.
 */
  diagnostics(): { synchronous: number; journalMode: string } {
    this.assertAvailable()
    const synchronous = this.db.prepare('PRAGMA synchronous').get()?.synchronous
    const journalMode = this.db.prepare('PRAGMA journal_mode').get()?.journal_mode
    if (typeof synchronous !== 'number' || typeof journalMode !== 'string') throw new AuthError('auth/storage', 'SQLite diagnostics are unavailable.')
    return { synchronous, journalMode }
  }

  /** Abort admissions, close SQLite, then release the process ownership lock. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.failure.abort(new AuthError('auth/unavailable', 'Authentication storage stopped.'))
    this.listeners.clear()
    try { this.db.close() } finally { await this.owner.close() }
  }

  private assertAvailable(): void {
    if (this.closed || this.failure.signal.aborted) throw new AuthError('auth/unavailable', 'Authentication storage is unavailable.')
    try {
      this.owner.assertOwned()
      if (fileIdentity(this.path) !== this.identity) throw new AuthError('auth/storage', 'Authentication database was replaced.')
    } catch (error) {
      this.failure.abort(error)
      throw new AuthError('auth/storage', 'Authentication storage identity changed; recover offline.', { cause: error })
    }
  }
}

/**
 * Open the exclusively owned Linux authentication database.
 * *
 * @param options - absolute private database path and maintenance/open mode.
 * *
 * @returns initialized store; caller must close after dependent work drains.
 */
export async function openAuthStore(options: OpenAuthStoreOptions): Promise<SqliteAuthStore> {
  if (!isAbsolute(options.path) || resolve(options.path) !== options.path) throw new AuthError('auth/storage', 'Authentication database path must be absolute.')
  if (process.platform !== 'linux') assertAuthStoragePlatform(process.platform, '')
  const owner = await AuthOwnership.acquire(options.path)
  let db: DatabaseSync | undefined
  try {
    const kind = statfsSync(dirname(options.path)).type
    const filesystem = new Map([[0xef53, 'ext4'], [0x58465342, 'xfs'], [0x9123683e, 'btrfs'], [0x794c7630, 'overlay']]).get(kind) ?? 'unsupported'
    assertAuthStoragePlatform(process.platform, filesystem)
    const flags = constants.O_RDWR | constants.O_NOFOLLOW | (options.mode === 'initialize' ? constants.O_CREAT | constants.O_EXCL : 0)
    const fd = openSync(options.path, flags, 0o600)
    try { fsyncSync(fd) } finally { closeSync(fd) }
    fileIdentity(options.path)
    db = new DatabaseSync(options.path)
    const version = db.prepare('PRAGMA user_version').get()?.user_version
    if ((options.mode === 'open' && version !== 1) || (options.mode === 'initialize' && version !== 0)) {
      throw new AuthError('auth/storage', 'Authentication database version is unsupported.')
    }
    db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA trusted_schema=OFF')
    if (options.mode === 'initialize') {
      if (version !== 0) throw new AuthError('auth/storage', 'Authentication database is already initialized.')
      db.exec('BEGIN IMMEDIATE; CREATE TABLE auth_state (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), document TEXT NOT NULL) STRICT; PRAGMA user_version=1; COMMIT')
    } else if (version !== 1) throw new AuthError('auth/storage', 'Authentication database version is unsupported.')
    const directoryFd = openSync(dirname(options.path), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { fsyncSync(directoryFd) } finally { closeSync(directoryFd) }
    const store = new SqliteAuthStore(db, owner, options.path)
    if (options.mode === 'open' && store.read() === undefined) throw new AuthError('auth/not-initialized', 'Initialize authentication offline before starting the Host.')
    const settings = store.diagnostics()
    if (settings.synchronous !== 2 || settings.journalMode !== 'wal') throw new AuthError('auth/storage', 'SQLite durability settings could not be enabled.')
    return store
  } catch (error) {
    try { db?.close() } finally { await owner.close() }
    throw error
  }
}
function fileIdentity(path: string): string {
  const info = lstatSync(path)
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o077) !== 0) {
    throw new AuthError('auth/storage', 'Authentication database must be a private file owned by the current Linux user.')
  }
  return `${info.dev}:${info.ino}`
}
function freezeState(state: AuthState): Readonly<AuthState> {
  Object.freeze(state.deployment)
  Object.freeze(state.password)
  for (const key of state.passkeys) { Object.freeze(key.transports); Object.freeze(key) }
  for (const session of state.sessions) Object.freeze(session)
  Object.freeze(state.passkeys)
  Object.freeze(state.sessions)
  return Object.freeze(state)
}
