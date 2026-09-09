import type { DaytonaSandboxLike } from './daytona-surface'
import { describe, expect, it } from 'vitest'
import { createDaytonaFiles } from './daytona-files'
import { notFound } from './daytona-session.fixtures'

function fakeDaytona(bytes = new Uint8Array([0xFF, 0x00, 0x41])) {
  const written: { path: string, data: Uint8Array }[] = []
  const folders: { path: string, mode: string }[] = []
  const read: string[] = []
  const sandbox = {
    fs: {
      downloadFile: async (path: string) => {
        read.push(path)
        return bytes
      },
      uploadFileStream: async (source: Uint8Array, remotePath: string) => {
        written.push({ path: remotePath, data: source })
      },
      createFolder: async (path: string, mode: string) => {
        folders.push({ path, mode })
      },
      getFileDetails: async (path: string) => {
        throw notFound(path)
      },
    },
  } as unknown as DaytonaSandboxLike
  return { files: createDaytonaFiles(sandbox), written, folders, read }
}

describe('createDaytonaFiles', () => {
  /**
   * Daytona has no streaming read this runtime can use — `downloadFileStream` returns a Node
   * `Readable`, and the SDK's own JSDoc sends serverless callers to `downloadFile`. So the
   * contract's streaming overload is satisfied by wrapping the downloaded bytes.
   */
  it('answers encoding \'none\' with a stream over the downloaded bytes', async () => {
    const daytona = fakeDaytona(new TextEncoder().encode('hi'))
    const result = await daytona.files.readFile('/x', { encoding: 'none' })

    expect(result.content).toBeInstanceOf(ReadableStream)
    const chunks: Uint8Array[] = []
    for await (const chunk of result.content as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
    }
    expect(new TextDecoder().decode(chunks[0])).toBe('hi')
  })

  it('decodes as utf-8 by default, reporting what it chose', async () => {
    const daytona = fakeDaytona(new TextEncoder().encode('hi'))
    expect(await daytona.files.readFile('/x')).toEqual({ content: 'hi', encoding: 'utf-8' })
  })

  it('produces base64 from the bytes, a format Daytona cannot be asked for', async () => {
    const daytona = fakeDaytona()
    expect(await daytona.files.readFile('/x', { encoding: 'base64' }))
      .toEqual({ content: '/wBB', encoding: 'base64' })
  })

  /**
   * `uploadFile(string, path)` treats its first argument as a *local file path*, so a text write
   * has to be encoded to bytes and pushed through `uploadFileStream` — the Buffer-free path.
   */
  it('writes text as encoded bytes rather than as a local path', async () => {
    const daytona = fakeDaytona()
    await daytona.files.writeFile('/x', 'plain')

    expect(daytona.written[0]?.path).toBe('/x')
    expect(new TextDecoder().decode(daytona.written[0]?.data)).toBe('plain')
  })

  it('stores the bytes a base64 write names, not the encoded text', async () => {
    const daytona = fakeDaytona()
    await daytona.files.writeFile('/x', '/wBB', { encoding: 'base64' })

    expect([...(daytona.written[0]?.data ?? [])]).toEqual([0xFF, 0x00, 0x41])
  })

  it('collects a streamed write, which Daytona cannot take chunk by chunk here', async () => {
    const daytona = fakeDaytona()
    await daytona.files.writeFile('/x', new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('one-'))
        controller.enqueue(new TextEncoder().encode('two'))
        controller.close()
      },
    }))

    expect(new TextDecoder().decode(daytona.written[0]?.data)).toBe('one-two')
  })

  /** `createFolder` needs a mode the contract has no counterpart for, and creates parents. */
  it('creates a directory the sandbox\'s own shell can write into', async () => {
    const daytona = fakeDaytona()
    await daytona.files.mkdir('/a/b', { recursive: true })

    expect(daytona.folders).toEqual([{ path: '/a/b', mode: '755' }])
  })
})
