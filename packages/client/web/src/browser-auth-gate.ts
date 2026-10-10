/** Optional authentication admission before the browser creates its business module graph. */

/**
 * Check the server-injected single-user marker before plugin prefetch.
 * @param metadata - optional JSON bootstrap marker; absent for default profiles.
 * @param fetcher - same-origin authentication transport.
 * @param navigate - full-document login navigation.
 * @param dispose - release the existing client tree and private page contents first.
 * @returns whether business startup may proceed.
 */
export async function checkBrowserAuthBeforeBoot(
  metadata: unknown, fetcher: typeof fetch, navigate: (path: string) => void, dispose: () => Promise<void>,
): Promise<boolean> {
  if (metadata === undefined) return true
  if (typeof metadata !== 'object' || metadata === null || !('mountPath' in metadata)
    || typeof metadata.mountPath !== 'string') throw new Error('Authentication bootstrap is invalid.')
  const mount = metadata.mountPath
  if (!mount.startsWith('/') || !mount.endsWith('/') || /[%?#\\]/.test(mount)
    || mount.includes('//') || new URL(mount, 'http://dsh.internal').pathname !== mount) {
    throw new Error('Authentication mount path is invalid.')
  }
  const response = await fetcher(mount + 'auth/state', { credentials: 'same-origin', cache: 'no-store',
    headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error('Authentication state is unavailable.')
  const value: unknown = await response.json()
  if (typeof value !== 'object' || value === null || !('authenticated' in value)
    || typeof value.authenticated !== 'boolean') throw new Error('Authentication state is invalid.')
  if (value.authenticated) return true
  await dispose()
  navigate(mount + 'auth/login')
  return false
}
