import { describe, expect, it, vi } from 'vitest'
import { fakeSandbox } from './cloudflare.fixtures'

vi.mock('cloudflare:workers', async () => (await import('./fake-workers')).workersModule)
vi.mock('@cloudflare/sandbox', async () => (await import('./fake-workers')).sandboxModule)

const BYTES = new Uint8Array([0xFF, 0x00, 0x7F])

describe('files', () => {
  it('reads utf-8 by default, base64 when asked, and a stream for none', async () => {
    const { container, session } = fakeSandbox()
    container.fs.files.set('/workspace/a.txt', new TextEncoder().encode('한글 text'))
    container.fs.files.set('/workspace/b.bin', BYTES)
    const s = session()

    expect(await s.readFile('/workspace/a.txt')).toEqual({ content: '한글 text', encoding: 'utf-8' })
    expect(await s.readFile('/workspace/b.bin', { encoding: 'base64' })).toEqual({ content: '/wB/', encoding: 'base64' })
    const { content } = await s.readFile('/workspace/b.bin', { encoding: 'none' })
    expect(new Uint8Array(await new Response(content).arrayBuffer())).toEqual(BYTES)
  })

  it('rejects a read of a path that does not exist', async () => {
    const { session } = fakeSandbox()

    await expect(session().readFile('/workspace/missing')).rejects.toThrow(/ENOENT/)
    await expect(session().readFile('/workspace/missing', { encoding: 'none' })).rejects.toThrow(/ENOENT/)
  })

  it('creates the parent directory before writing', async () => {
    const { container, session } = fakeSandbox()
    await session().writeFile('/workspace/deep/new/a.txt', 'hello')

    expect(new TextDecoder().decode(container.fs.files.get('/workspace/deep/new/a.txt'))).toBe('hello')
  })

  it('writes the bytes a base64 string stands for, and a stream as it comes', async () => {
    const { container, session } = fakeSandbox()
    const s = session()
    await s.writeFile('/workspace/b.bin', '/wB/', { encoding: 'base64' })
    await s.writeFile('/workspace/c.bin', new Response(BYTES).body!)

    expect(container.fs.files.get('/workspace/b.bin')).toEqual(BYTES)
    expect(container.fs.files.get('/workspace/c.bin')).toEqual(BYTES)
  })

  it('makes a directory non-recursively unless asked', async () => {
    const { container, session } = fakeSandbox()
    const s = session()

    await expect(s.mkdir('/workspace/x/y')).rejects.toThrow(/ENOENT/)
    await s.mkdir('/workspace/x/y', { recursive: true })
    expect(['/workspace', '/workspace/x', '/workspace/x/y'].every(dir => container.fs.dirs.has(dir))).toBe(true)
  })

  it('answers exists false only for ENOENT, starting the container to ask', async () => {
    const { container, session } = fakeSandbox()
    const s = session()

    expect(await s.exists('/workspace/nothing')).toEqual({ exists: false })
    expect(container.start).toHaveBeenCalledOnce()
    await s.mkdir('/workspace', { recursive: true })
    expect(await s.exists('/workspace')).toEqual({ exists: true })
    await expect(s.exists('/forbidden/x')).rejects.toThrow(/EACCES/)
  })
})
