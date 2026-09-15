import type { SandboxFileContent, SandboxFileStream } from '@amond-ai/sandbox'
import { describe, expect, it } from 'vitest'
import { createVercelFiles, pathExists, VercelFileNotFoundError } from './vercel-files'
import { decode, encode, fakeSandbox } from './vercel-sandbox.fake'

async function drain(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

describe('readFile', () => {
  it('decodes as utf-8 by default and reports the encoding it chose', async () => {
    const fake = fakeSandbox()
    fake.files.set('/work/notes.md', encode('안녕 hello'))

    const read = await createVercelFiles(fake.sandbox).readFile('/work/notes.md') as SandboxFileContent
    expect(read).toEqual({ content: '안녕 hello', encoding: 'utf-8' })
  })

  it('produces base64 from the bytes, since the API has no such format', async () => {
    const fake = fakeSandbox()
    fake.files.set('/work/bin', new Uint8Array([0, 1, 2, 255]))

    const read = await createVercelFiles(fake.sandbox).readFile('/work/bin', { encoding: 'base64' }) as SandboxFileContent
    expect(read).toEqual({ content: btoa(String.fromCharCode(0, 1, 2, 255)), encoding: 'base64' })
  })

  it('wraps the bytes in a one-chunk stream for encoding: none', async () => {
    // The SDK's streaming read returns a `NodeJS.ReadableStream`, which this package may not
    // name, so the bytes are already in hand by the time the caller asks for a stream. The shape
    // is what the contract wants; the laziness is not available at any price here.
    const fake = fakeSandbox()
    fake.files.set('/work/big', encode('chunky'))

    const read = await createVercelFiles(fake.sandbox).readFile('/work/big', { encoding: 'none' }) as SandboxFileStream
    expect(decode(await drain(read.content))).toBe('chunky')
  })

  it('rejects for a file that is not there, rather than answering null', async () => {
    // `readFileToBuffer` answers `null`; the contract says `readFile` rejects and pairs with
    // `exists` for callers that want absence as a value. A named error is what lets a caller
    // tell that apart from a transport failure.
    const fake = fakeSandbox()

    await expect(createVercelFiles(fake.sandbox).readFile('/work/gone')).rejects.toThrow(VercelFileNotFoundError)
  })
})

describe('writeFile', () => {
  it('writes text as text', async () => {
    const fake = fakeSandbox()
    await createVercelFiles(fake.sandbox).writeFile('/work/a.txt', 'hello')

    expect(decode(fake.files.get('/work/a.txt') ?? new Uint8Array())).toBe('hello')
  })

  it('writes the bytes a base64 string stands for, not the string', async () => {
    // A base64 write means "these are the bytes": handing the string through unchanged would
    // persist the encoding rather than the file.
    const fake = fakeSandbox()
    await createVercelFiles(fake.sandbox).writeFile('/work/bin', btoa('hi'), { encoding: 'base64' })

    expect(decode(fake.files.get('/work/bin') ?? new Uint8Array())).toBe('hi')
  })

  it('collects a stream, since there is no chunked write this runtime can reach', async () => {
    const fake = fakeSandbox()
    const content = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('one '))
        controller.enqueue(encode('two'))
        controller.close()
      },
    })

    await createVercelFiles(fake.sandbox).writeFile('/work/joined', content)
    expect(decode(fake.files.get('/work/joined') ?? new Uint8Array())).toBe('one two')
  })
})

describe('mkdir', () => {
  it('always creates parents, whatever was asked for', async () => {
    // `sandbox.mkDir` creates one level. A non-recursive request is satisfied by a recursive
    // create, never the other way round, and a caller asking for a nested path would otherwise
    // fail on a parent it had no reason to think about.
    const fake = fakeSandbox()
    await createVercelFiles(fake.sandbox).mkdir('/work/a/b/c')

    expect(fake.dirs.has('/work/a/b/c')).toBe(true)
    expect(fake.ran[0]?.args[1]).toBe('mkdir -p -- "$1"')
  })
})

describe('pathExists', () => {
  it('answers false only when the sandbox said so', async () => {
    const fake = fakeSandbox()
    fake.files.set('/work/there', encode('x'))

    expect(await pathExists(fake.sandbox, '/work/there')).toBe(true)
    expect(await pathExists(fake.sandbox, '/work/not-there')).toBe(false)
  })

  it('lets a dead transport through rather than reading it as absence', async () => {
    // The harness decides from this whether the bridge bundle needs installing, so
    // absence-on-failure would reinstall it on every turn — and would read a sandbox nobody can
    // reach as an empty one.
    const fake = fakeSandbox()
    fake.failing.add('test -e')

    await expect(pathExists(fake.sandbox, '/work/there')).rejects.toThrow(/transport failure/)
  })
})
