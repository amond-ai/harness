import { describe, expect, it } from 'vitest'
import { createJournalIo } from './journal-io'
import { createLocalFiles } from './local-files'
import { decode, encode, fakeHost, WORK } from './local.fixtures'

function filesOver(root = WORK) {
  const fake = fakeHost()
  return { fake, files: createLocalFiles(fake.host, createJournalIo(fake.host), root) }
}

describe('createLocalFiles', () => {
  it('resolves a caller\'s absolute path inside the sandbox, not on the machine', async () => {
    // A caller of this contract writes container-absolute paths. Resolving those against the
    // real filesystem would answer `/etc/passwd` with the host's copy of it.
    const { fake, files } = filesOver()
    await files.writeFile('/etc/passwd', 'not the real one')
    expect(decode(fake.files.get(`${WORK}/etc/passwd`)!)).toBe('not the real one')
    expect(fake.files.has('/etc/passwd')).toBe(false)
  })

  it('refuses a path that climbs out of the sandbox', async () => {
    const { files } = filesOver()
    await expect(files.readFile('../run-43/.env')).rejects.toThrow(/outside the sandbox root/)
  })

  it('decodes as utf-8 by default, reporting what it chose', async () => {
    const { fake, files } = filesOver()
    fake.put(`${WORK}/x`, 'hi')
    await expect(files.readFile('x')).resolves.toEqual({ content: 'hi', encoding: 'utf-8' })
  })

  it('produces base64 from the bytes', async () => {
    const { fake, files } = filesOver()
    fake.files.set(`${WORK}/x`, new Uint8Array([0xFF, 0x00, 0x41]))
    await expect(files.readFile('x', { encoding: 'base64' })).resolves.toEqual({
      content: '/wBB',
      encoding: 'base64',
    })
  })

  it('stores the bytes a base64 write names, not the encoded text', async () => {
    const { fake, files } = filesOver()
    await files.writeFile('x', '/wBB', { encoding: 'base64' })
    expect([...fake.files.get(`${WORK}/x`)!]).toEqual([0xFF, 0x00, 0x41])
  })

  it('streams a read the caller asked not to decode', async () => {
    const { fake, files } = filesOver()
    fake.put(`${WORK}/x`, 'streamed')
    const result = await files.readFile('x', { encoding: 'none' })
    expect(result.content).toBeInstanceOf(ReadableStream)
    const chunks: Uint8Array[] = []
    for await (const chunk of result.content) {
      chunks.push(chunk)
    }
    expect(chunks.map(decode).join('')).toBe('streamed')
  })

  it('collects a streamed write, which the host surface cannot take as a stream', async () => {
    const { fake, files } = filesOver()
    await files.writeFile('x', new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encode('ab'))
        controller.close()
      },
    }))
    expect(decode(fake.files.get(`${WORK}/x`)!)).toBe('ab')
  })

  it('rejects a read of a file that is not there, rather than answering empty', async () => {
    // By contract: callers that want absence as a value pair this with `exists`, and an empty
    // file is a legitimate answer that must stay distinguishable from a missing one.
    const { fake, files } = filesOver()
    fake.put(`${WORK}/empty`, '')
    await expect(files.readFile('empty')).resolves.toEqual({ content: '', encoding: 'utf-8' })
    await expect(files.readFile('missing')).rejects.toThrow(/no such file/)
  })

  it('creates parents, because a non-recursive request is satisfied by a recursive create', async () => {
    const { fake, files } = filesOver()
    await files.mkdir('a/b/c')
    expect(fake.dirs.has(`${WORK}/a/b/c`)).toBe(true)
  })

  it('creates the parent of a written file, the way both sibling backends do', async () => {
    const { fake, files } = filesOver()
    await files.writeFile('a/b/note.txt', 'hi')
    expect(fake.dirs.has(`${WORK}/a/b`)).toBe(true)
  })
})
