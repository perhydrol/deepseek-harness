/** Login HTML cannot expose the business module graph or application startup data. */
import { expect, it } from 'vitest'
import { renderAuthPage } from '../src/index.ts'

it('contains only authentication assets and encoded public mount metadata', () => {
  const html = renderAuthPage('login', '/private/')
  expect(html).toContain('src="./client.js"')
  expect(html).toContain('href="./client.css"')
  expect(html).toContain('data-auth-mount="%2Fprivate%2F"')
  expect(html).not.toContain('__DSH_BOOT__')
  expect(html).not.toContain('__ModuleLoader__')
  expect(html).not.toContain('/plugins/')
})
