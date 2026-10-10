/** Login-only entry without the business module loader or application manifest. */
import { AuthClient } from './auth-client.ts'
import { mountAuthPage } from './page.ts'

const root = document.getElementById('auth-root')
if (root === null) throw new Error('Authentication page container is missing.')
const mode = root.dataset.authMode
if (mode !== 'login' && mode !== 'security') throw new Error('Authentication page mode is invalid.')
const mountPath = decodeURIComponent(root.dataset.authMount ?? '')
if (!mountPath.startsWith('/') || !mountPath.endsWith('/')) throw new Error('Authentication page mount is invalid.')
if (globalThis.matchMedia('(prefers-color-scheme: dark)').matches) document.body.setAttribute('data-ds-dark-theme', '')
void mountAuthPage(root, new AuthClient(mountPath), mode, (path) => { location.replace(path) }, navigator.language)
