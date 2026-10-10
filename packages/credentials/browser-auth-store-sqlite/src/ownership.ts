/** Linux process-lifetime ownership of private authentication files. */
import { constants, lstatSync, statSync } from 'node:fs'
import { open, mkdir, chmod, realpath } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { dirname } from 'node:path'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import { AuthError } from '@hydrogen/dsh-browser-auth'

/** Held flock and stable directory/file identities; release never unlinks the lock. */
export class AuthOwnership {
  private closed = false
  private constructor(
    private readonly handle: FileHandle,
    private readonly path: string,
    private readonly directory: string,
    private readonly lockIdentity: string,
    private readonly directoryIdentity: string,
  ) {}

  /**
 * Acquire a private Linux directory and a nonblocking exclusive kernel lock.
 * *
 * @param path - absolute database path.
 * *
 * @returns ownership retained until explicit close.
 */
  static async acquire(path: string): Promise<AuthOwnership> {
    if (process.platform !== 'linux') throw new AuthError('auth/unsupported-platform', 'Authentication storage requires Linux.')
    const uid = process.getuid?.()
    const directory = dirname(path)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    if (await realpath(directory) !== directory) throw new AuthError('auth/ownership', 'Authentication directory must use its canonical path without symbolic links.')
    const info = lstatSync(directory)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== uid) {
      throw new AuthError('auth/ownership', 'Authentication directory must be owned by the current Linux user and must not be a symbolic link.')
    }
    await chmod(directory, 0o700)
    await syncAncestors(directory)
    const lockPath = path + '.lock'
    const handle = await open(lockPath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
    try {
      await tryLockExclusive(handle.fd)
      const held = await handle.stat()
      if (!held.isFile() || held.uid !== uid) throw new AuthError('auth/ownership', 'Authentication lock ownership is invalid.')
      await handle.chmod(0o600)
      const ownership = new AuthOwnership(handle, lockPath, directory, identity(held), identity(info))
      ownership.assertOwned()
      return ownership
    } catch (error) {
      await handle.close()
      throw new AuthError('auth/ownership', 'Authentication storage is already owned or its lock is unavailable; stop the Host before maintenance.', { cause: error })
    }
  }

  /** Refuse replaced directories, removed locks and closed ownership. */
  assertOwned(): void {
    if (this.closed || identity(lstatSync(this.directory)) !== this.directoryIdentity
      || identity(statSync(this.path)) !== this.lockIdentity || lstatSync(this.path).isSymbolicLink()) {
      throw new AuthError('auth/ownership', 'Authentication storage identity changed; stop the Host and recover offline.')
    }
  }

  /** Release the kernel lock after all dependent work and database handles close. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.handle.close()
  }
}
function identity(info: { dev: number; ino: number }): string { return `${info.dev}:${info.ino}` }

async function syncAncestors(path: string): Promise<void> {
  let current = path
  while (true) {
    const handle = await open(current, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    try { await handle.sync() } finally { await handle.close() }
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}
