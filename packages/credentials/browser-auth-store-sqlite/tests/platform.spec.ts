/** Unqualified persistence platforms must fail before touching authentication data. */
import { expect, it } from 'vitest'
import { assertAuthStoragePlatform } from '../src/platform.ts'

it('rejects Windows and network filesystems explicitly', () => {
  expect(() =>{  assertAuthStoragePlatform('win32', 'ntfs') }).toThrow(/Linux/)
  expect(() =>{  assertAuthStoragePlatform('linux', 'nfs') }).toThrow(/local filesystem/)
  expect(() =>{  assertAuthStoragePlatform('linux', 'cifs') }).toThrow(/local filesystem/)
  expect(() =>{  assertAuthStoragePlatform('linux', 'ext4') }).not.toThrow()
})
