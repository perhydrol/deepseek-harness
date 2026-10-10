/** Linux filesystem qualification for authentication durability. */
import { AuthError } from '@hydrogen/dsh-browser-auth'

/**
 * Refuse platforms and filesystems without the required local sync semantics.
 * *
 * @param platform - operating system reported by Node.
 * *
 * @param filesystem - filesystem reported by the store directory probe.
 */
export function assertAuthStoragePlatform(platform: string, filesystem: string): void {
  if (platform !== 'linux') throw new AuthError('auth/unsupported-platform', 'Single-user authentication storage requires Linux.')
  if (!['ext4', 'xfs', 'btrfs', 'overlay'].includes(filesystem)) {
    throw new AuthError('auth/unsupported-platform', 'Authentication requires a supported persistent local filesystem: ext4, xfs or btrfs.')
  }
}
