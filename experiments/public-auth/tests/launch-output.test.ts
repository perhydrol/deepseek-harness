import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaunchOutput } from '../src/launch-output.ts'

test('captures only the configured loopback launch URL and redacts split tokens on both streams', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-launch-'))
  try {
    const file = join(directory, 'launch-url')
    let output = ''
    const capture = createLaunchOutput(file, 'http://127.0.0.1:3081', line => { output += line })
    capture.stdout.write('dsh web: http://127.0.0.1:3081/?tok')
    capture.stdout.write('en=private-first\n')
    capture.stderr.write('failed http://127.0.0.1:3081/?token=private-error\n')
    capture.stdout.end('dsh web: https://attacker.invalid/?token=private-other\n')
    capture.stderr.end('partial ?token=private-tail')
    await capture.finished()
    assert.equal(await readFile(file, 'utf8'), 'http://127.0.0.1:3081/?token=private-first\n')
    assert.doesNotMatch(output, /private-/)
    const next = createLaunchOutput(file, 'http://127.0.0.1:3081', () => {})
    next.stdout.end('dsh web: http://127.0.0.1:3081/?token=replacement\n')
    next.stderr.end()
    await next.finished()
    assert.match(await readFile(file, 'utf8'), /token=replacement/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('capture fails without logging the private URL when its destination cannot be written', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-launch-failure-'))
  try {
    let output = ''
    const capture = createLaunchOutput(join(directory, 'missing', 'launch-url'), 'http://127.0.0.1:3081',
      line => { output += line })
    const completed = capture.finished()
    capture.stdout.end('dsh web: http://127.0.0.1:3081/?token=private-failure\n')
    capture.stderr.end()
    await assert.rejects(completed, /Cannot capture private DSH startup output/)
    assert.doesNotMatch(output, /private-failure/)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
