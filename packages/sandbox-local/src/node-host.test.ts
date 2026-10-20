import { execFileSync } from 'node:child_process'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { nodeLocalHost } from './node-host'

describe('nodeLocalHost.createFile', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sandbox-local-create-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('lets exactly one concurrent caller publish, with the winner\'s complete contents', async () => {
    const host = nodeLocalHost()
    const target = join(dir, '.nonce')
    const values = Array.from({ length: 16 }, (_, i) => `value-${i}-${'x'.repeat(40)}`)
    const results = await Promise.all(values.map(async v => host.createFile(target, new TextEncoder().encode(v))))
    expect(results.filter(Boolean)).toHaveLength(1)
    const winner = values[results.indexOf(true)]
    expect(await readFile(target, 'utf8')).toBe(winner)
    expect(await readdir(dir)).toEqual(['.nonce'])
  })

  it('refuses to replace an existing file and leaves no staging file behind', async () => {
    const host = nodeLocalHost()
    const target = join(dir, '.nonce')
    await writeFile(target, 'first')
    await expect(host.createFile(target, new TextEncoder().encode('second'))).resolves.toBe(false)
    expect(await readFile(target, 'utf8')).toBe('first')
    expect(await readdir(dir)).toEqual(['.nonce'])
  })
})

describe('nodeLocalHost.readSlice', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sandbox-local-read-'))
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it.skipIf(process.platform === 'win32')('rejects a FIFO promptly instead of blocking on its open', async () => {
    // A sandbox's own command can replace a state file with a FIFO. A blocking open of one with
    // no writer never returns, so the timeout is what turns a regression into a failure rather
    // than a stalled suite.
    const fifo = join(dir, '.nonce')
    execFileSync('mkfifo', [fifo])
    await expect(nodeLocalHost().readSlice(fifo, 0, 64)).rejects.toMatchObject({ code: 'EINVAL' })
  }, 2_000)

  it('reads a regular file and reports a missing one as empty', async () => {
    const file = join(dir, 'journal')
    await writeFile(file, 'hello')
    const host = nodeLocalHost()
    const slice = await host.readSlice(file, 1, 3)
    expect(new TextDecoder().decode(slice.data)).toBe('ell')
    expect(slice.total).toBe(5)
    await expect(host.readSlice(join(dir, 'absent'), 0)).resolves.toMatchObject({ total: 0 })
  })
})
