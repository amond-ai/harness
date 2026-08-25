import { describe, expect, it } from 'bun:test'
import { createFileSurface } from './files'
import { fakeSandboxProvider } from './sandbox.fixtures'

function surface(
  seed: Record<string, Uint8Array | string> = {},
  beforeRead?: (path: string) => void,
) {
  const { provider, state } = fakeSandboxProvider({ beforeRead })
  for (const [path, content] of Object.entries(seed)) {
    state.files('sbx').set(path, typeof content === 'string' ? new TextEncoder().encode(content) : content)
  }
  return { files: createFileSurface(provider.session('sbx')), state }
}

/**
 * The fixture has to be able to tell two sandboxes apart, or every "reached the sandbox it was
 * bound to" assertion in this package pins nothing: a surface that resolved the wrong id would
 * find the file there anyway and pass. Shared file state is what made that true here, and a
 * misrouted read is the failure that state cannot express (cubic review, PR #268).
 */
describe('sandbox isolation', () => {
  it('does not show one sandbox a file written to another', async () => {
    const { provider } = fakeSandboxProvider()
    const one = createFileSurface(provider.session('sbx-1'))
    const two = createFileSurface(provider.session('sbx-2'))
    await one.writeTextFile({ path: '/only-in-one.txt', content: 'here' })

    expect(await two.readTextFile({ path: '/only-in-one.txt' })).toBeNull()
    expect(await one.readTextFile({ path: '/only-in-one.txt' })).toBe('here')
  })
})

describe('reads', () => {
  /**
   * The contract's `readFile` *rejects* on a missing path and the harness's reads answer
   * `null`; the contract's own note says a caller wanting absence-as-value pairs it with
   * `exists`. A surface that let the rejection through would turn a routine "no such file"
   * into a failed tool call.
   */
  it('answers null for a path that is not there rather than rejecting', async () => {
    const { files } = surface()

    expect(await files.readFile({ path: '/gone' })).toBeNull()
    expect(await files.readBinaryFile({ path: '/gone' })).toBeNull()
    expect(await files.readTextFile({ path: '/gone' })).toBeNull()
  })

  it('streams the bytes of a file that is there', async () => {
    const { files } = surface({ '/a.txt': 'hello' })
    const stream = await files.readFile({ path: '/a.txt' })

    expect(await new Response(stream).text()).toBe('hello')
  })

  /**
   * Through the streaming overload, not base64: it is the exact bytes with one decode fewer,
   * and a base64 round trip would be an extra transcoding of every byte read.
   */
  it('reads bytes through the streaming overload', async () => {
    const bytes = new Uint8Array([0x00, 0xFF, 0x80, 0x41, 0x0A])
    const { files, state } = surface({ '/bin': bytes })

    expect(await files.readBinaryFile({ path: '/bin' })).toEqual(bytes)
    expect(state.reads.at(-1)?.encoding).toBe('none')
  })

  it('decodes text with the requested encoding', async () => {
    const { files } = surface({ '/u16': new Uint8Array([0x68, 0x00, 0x69, 0x00]) })

    expect(await files.readTextFile({ path: '/u16', encoding: 'utf-16le' })).toBe('hi')
  })

  it('returns the whole file when no line range is asked for', async () => {
    const { files } = surface({ '/a.txt': 'one\ntwo\nthree\n' })

    expect(await files.readTextFile({ path: '/a.txt' })).toBe('one\ntwo\nthree\n')
  })

  /** The harness documents the range as 1-based and inclusive on both ends. */
  it('slices a 1-based inclusive line range', async () => {
    const { files } = surface({ '/a.txt': 'one\ntwo\nthree\nfour' })

    expect(await files.readTextFile({ path: '/a.txt', startLine: 2, endLine: 3 })).toBe('two\nthree')
  })

  it('reads from a start line through the end of the file', async () => {
    const { files } = surface({ '/a.txt': 'one\ntwo\nthree' })

    expect(await files.readTextFile({ path: '/a.txt', startLine: 2 })).toBe('two\nthree')
  })

  /**
   * 1-based is the contract, so line 0 is outside it — and passed straight on as a negative
   * slice index it would mean *the last* line, the one wrong answer that still looks like a
   * successful read.
   */
  it('clamps a start line below the first one to the first line', async () => {
    const { files } = surface({ '/a.txt': 'one\ntwo\nthree' })

    expect(await files.readTextFile({ path: '/a.txt', startLine: 0, endLine: 2 })).toBe('one\ntwo')
  })

  it('returns through EOF when the end line is past the last one', async () => {
    const { files } = surface({ '/a.txt': 'one\ntwo' })

    expect(await files.readTextFile({ path: '/a.txt', startLine: 1, endLine: 99 })).toBe('one\ntwo')
  })
})

describe('writes', () => {
  /**
   * The harness requires every write to create parent directories recursively; the contract's
   * `writeFile` promises nothing of the sort, and whether Cloudflare's does is not something
   * this package can establish. So the `mkdir` is unconditional.
   */
  it('creates the parent directory recursively before every write', async () => {
    const { files, state } = surface()
    await files.writeTextFile({ path: '/deep/nested/a.txt', content: 'x' })
    await files.writeBinaryFile({ path: '/deep/nested/b.bin', content: new Uint8Array([1]) })
    await files.writeFile({ path: '/deep/nested/c.bin', content: new Response('c').body! })

    expect(state.mkdirs).toEqual([
      { path: '/deep/nested', recursive: true },
      { path: '/deep/nested', recursive: true },
      { path: '/deep/nested', recursive: true },
    ])
    // "Before" is the requirement, and the two lists above cannot express it: a surface that
    // wrote first and created the parent afterwards records exactly the same `mkdirs` and the
    // same `writes`, and fails only against a real backend, where the write has nowhere to go.
    expect(state.events).toEqual([
      'mkdir /deep/nested',
      'write /deep/nested/a.txt',
      'mkdir /deep/nested',
      'write /deep/nested/b.bin',
      'mkdir /deep/nested',
      'write /deep/nested/c.bin',
    ])
    // And that each write actually landed, which is the outcome the ordering is for.
    expect(new TextDecoder().decode(state.files('sbx').get('/deep/nested/a.txt'))).toBe('x')
    expect(state.files('sbx').get('/deep/nested/b.bin')).toEqual(new Uint8Array([1]))
    expect(new TextDecoder().decode(state.files('sbx').get('/deep/nested/c.bin'))).toBe('c')
  })

  it('asks for the root itself when the file sits directly in it', async () => {
    const { files, state } = surface()
    await files.writeTextFile({ path: '/a.txt', content: 'x' })

    expect(state.mkdirs).toEqual([{ path: '/', recursive: true }])
  })

  it('asks for no directory when the path has no parent segment', async () => {
    const { files, state } = surface()
    await files.writeTextFile({ path: 'bare.txt', content: 'x' })

    expect(state.mkdirs).toEqual([])
  })

  it('round-trips exact bytes, including ones no UTF-8 decode would survive', async () => {
    const bytes = new Uint8Array([0x00, 0xFF, 0xFE, 0x80, 0x41])
    const { files, state } = surface()
    await files.writeBinaryFile({ path: '/bin', content: bytes })

    expect(state.writes.at(-1)?.encoding).toBe('base64')
    expect(state.files('sbx').get('/bin')).toEqual(bytes)
  })

  it('round-trips a payload larger than one base64 chunk', async () => {
    // `String.fromCharCode(...bytes)` on a whole large array overflows the argument stack, so
    // the encoder chunks. The payload has to be big enough for that to bite: measured under
    // Bun 1.3.14, the spread survives 500_000 bytes and throws `RangeError` at 1_000_000, so
    // a smaller fixture would pass with the chunking removed.
    const bytes = new Uint8Array(1_000_000).map((_, index) => index % 256)
    const { files, state } = surface()
    await files.writeBinaryFile({ path: '/big', content: bytes })

    expect(state.files('sbx').get('/big')).toEqual(bytes)
  })

  it('writes text as text', async () => {
    const { files, state } = surface()
    await files.writeTextFile({ path: '/a.txt', content: 'héllo' })

    expect(new TextDecoder().decode(state.files('sbx').get('/a.txt'))).toBe('héllo')
  })

  it('streams a byte stream straight through', async () => {
    const { files, state } = surface()
    await files.writeFile({ path: '/c.bin', content: new Response('streamed').body! })

    expect(new TextDecoder().decode(state.files('sbx').get('/c.bin'))).toBe('streamed')
  })

  /**
   * The contract's write takes `string | ReadableStream`, and the only string encodings it
   * names are UTF-8 and base64 — there is no primitive here that encodes a JS string to
   * latin1 or UTF-16. Refusing is the honest answer; writing UTF-8 anyway would silently
   * corrupt the file the caller asked for.
   */
  it('refuses a text encoding it cannot actually produce', async () => {
    const { files } = surface()

    await expect(files.writeTextFile({ path: '/a.txt', content: 'x', encoding: 'utf-16le' }))
      .rejects
      .toThrow('utf-16le')
  })
})

/**
 * Absence found by the *read* rather than by the `exists` that preceded it.
 *
 * Every read here is two calls, and between them the sandbox is a live machine the agent's own
 * turn is running in: a path that existed for `exists` can be gone by the time `readFile` asks
 * for it — `git checkout`, a build that cleans its output, the turn deleting the file it just
 * listed. The contract rejects for that, and the harness's reads are documented to answer
 * `null`, so letting the rejection through turns an ordinary absence into a failed tool call
 * for the agent, at a rate that depends on how busy the sandbox is.
 *
 * The not-found is told apart from a real failure by asking `exists` again, because the
 * contract offers nothing else: `SandboxFiles.readFile` says only "rejects when the path does
 * not exist", with no error type, code or message a backend must use — and the three backends
 * throw whatever their transport throws. A re-probe is a fact about the sandbox rather than a
 * guess about an error's shape, and it costs a round trip only on the failing path.
 */
describe('reads racing a deletion', () => {
  it('answers null when the file is gone by the time the read lands', async () => {
    const paths = ['/vanishes', '/vanishes-bin', '/vanishes-text']
    const seed = Object.fromEntries(paths.map(path => [path, 'here for now']))
    const { files, state } = surface(seed, path => void state.files('sbx').delete(path))

    expect(await files.readFile({ path: paths[0] })).toBeNull()
    expect(await files.readBinaryFile({ path: paths[1] })).toBeNull()
    expect(await files.readTextFile({ path: paths[2] })).toBeNull()
  })

  /**
   * The other half, and the one that keeps this from being a swallow-everything `catch`: the
   * file is still there when the re-probe runs, so the read failed for its own reason and the
   * caller has to see it. A surface that mapped every rejection to `null` would report an
   * unreachable sandbox as an empty workspace, and the agent would act on that.
   */
  it('rethrows a read failure when the file is still there', async () => {
    const { files } = surface({ '/a.txt': 'still here' }, () => {
      throw new Error('transport blew up')
    })

    await expect(files.readFile({ path: '/a.txt' })).rejects.toThrow('transport blew up')
    await expect(files.readBinaryFile({ path: '/a.txt' })).rejects.toThrow('transport blew up')
    await expect(files.readTextFile({ path: '/a.txt' })).rejects.toThrow('transport blew up')
  })

  /**
   * A sandbox too broken to answer the read is usually too broken to answer the re-probe, and
   * that is the case where reading the probe's *failure* as absence would be worst: a whole
   * unreachable workspace would come back as file after file of `null`, and the agent would
   * conclude the repository is empty rather than that it cannot see it. So a re-probe that
   * throws counts as "may exist" and the original read error is what the caller gets.
   *
   * Written over a hand-built session because the fixture's `exists` cannot fail — it reads a
   * `Map` — and the two calls have to disagree in a way seeding cannot produce.
   */
  it('rethrows the read failure when the re-probe cannot answer either', async () => {
    const { provider } = fakeSandboxProvider()
    const session = provider.session('sbx')
    let probes = 0
    const files = createFileSurface({
      ...session,
      exists: () => {
        probes += 1
        // The first probe is the one that gates the read, and it has to say yes for the read
        // to happen at all; the second is the one under test.
        return probes === 1 ? Promise.resolve({ exists: true }) : Promise.reject(new Error('sandbox unreachable'))
      },
      readFile: (() => Promise.reject(new Error('transport blew up'))) as unknown as typeof session.readFile,
    })

    await expect(files.readBinaryFile({ path: '/a.txt' })).rejects.toThrow('transport blew up')
    expect(probes).toBe(2)
  })
})
