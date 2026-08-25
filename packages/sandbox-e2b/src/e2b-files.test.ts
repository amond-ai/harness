import type { E2bSandboxLike } from './e2b-surface'
import { describe, expect, it } from 'bun:test'
import { createE2bFiles } from './e2b-files'

function fakeE2b(bytes = new Uint8Array([0xFF, 0x00, 0x41])) {
  const written: { path: string, data: string | ArrayBuffer }[] = []
  const dirs: string[] = []
  const reads: { path: string, format: string }[] = []
  const sandbox = {
    files: {
      read: (async (path: string, opts: { format: string }) => {
        reads.push({ path, format: opts.format })
        return opts.format === 'stream'
          ? new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(bytes)
                controller.close()
              },
            })
          : bytes
      }) as E2bSandboxLike['files']['read'],
      write: async (path: string, data: string | ArrayBuffer) => {
        written.push({ path, data })
      },
      exists: async () => true,
      list: async () => [],
      makeDir: async (path: string) => {
        dirs.push(path)
        return true
      },
    },
  } as unknown as E2bSandboxLike
  return { files: createE2bFiles(sandbox), written, dirs, reads }
}

describe('createE2bFiles', () => {
  it('streams without collecting when the caller asks for encoding \'none\'', async () => {
    const e2b = fakeE2b()
    const result = await e2b.files.readFile('/x', { encoding: 'none' })
    expect(e2b.reads).toEqual([{ path: '/x', format: 'stream' }])
    expect(result.content).toBeInstanceOf(ReadableStream)
  })

  it('decodes as utf-8 by default, reporting what it chose', async () => {
    const e2b = fakeE2b(new TextEncoder().encode('hi'))
    const result = await e2b.files.readFile('/x')
    expect(result).toEqual({ content: 'hi', encoding: 'utf-8' })
  })

  it('produces base64 from the bytes, a format e2b cannot be asked for', async () => {
    const e2b = fakeE2b(new Uint8Array([0xFF, 0x00, 0x41]))
    const result = await e2b.files.readFile('/x', { encoding: 'base64' })
    expect(e2b.reads[0]?.format).toBe('bytes')
    expect(result).toEqual({ content: '/wBB', encoding: 'base64' })
  })

  it('writes text straight through', async () => {
    const e2b = fakeE2b()
    await e2b.files.writeFile('/x', 'plain')
    expect(e2b.written).toEqual([{ path: '/x', data: 'plain' }])
  })

  it('stores the bytes a base64 write names, not the encoded text', async () => {
    const e2b = fakeE2b()
    await e2b.files.writeFile('/x', '/wBB', { encoding: 'base64' })
    const written = e2b.written[0]?.data
    expect(written).toBeInstanceOf(ArrayBuffer)
    expect([...new Uint8Array(written as ArrayBuffer)]).toEqual([0xFF, 0x00, 0x41])
  })

  it('collects a streamed write, which e2b cannot take as a stream', async () => {
    const e2b = fakeE2b()
    await e2b.files.writeFile('/x', new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('ab'))
        c.close()
      },
    }))
    const written = e2b.written[0]?.data
    expect(new TextDecoder().decode(written as ArrayBuffer)).toBe('ab')
  })

  it('creates directories through makeDir, which is already recursive', async () => {
    const e2b = fakeE2b()
    await e2b.files.mkdir('/a/b', { recursive: true })
    expect(e2b.dirs).toEqual(['/a/b'])
  })
})
