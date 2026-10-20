import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
