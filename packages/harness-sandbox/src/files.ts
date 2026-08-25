/**
 * The harness's file surface over {@link SandboxSession}'s.
 *
 * Three differences have to be reconciled, and each one is a decision rather than a rename:
 *
 * - **Absence.** The contract's `readFile` rejects when the path is not there; the harness's
 *   reads answer `null`. The contract's own note names the fix — "callers wanting
 *   absence-as-value pair it with `exists`" — so every read here is an `exists` followed by a
 *   read. It costs a round trip and buys the harness's documented shape. The two calls can
 *   also disagree, and {@link createFileSurface}'s `readingAbsence` is where that is handled.
 * - **Parent directories.** The harness says of all three writes that they create parent
 *   directories recursively. The contract's `writeFile` promises nothing of the kind, and
 *   whether a given backend's does is not something this package can establish for backends
 *   it has never run against. So the `mkdir` is unconditional; a redundant recursive `mkdir`
 *   costs one call, a missing one loses the write.
 * - **Encodings.** The contract's write takes `string | ReadableStream<Uint8Array>` and names
 *   only UTF-8 and base64, so bytes go out as base64 and a text encoding the platform cannot
 *   produce is refused rather than silently written as UTF-8. Reads have no such limit —
 *   they decode the raw bytes with `TextDecoder`, which handles every label the harness's
 *   `encoding` option might name.
 *
 * `abortSignal` is accepted and ignored throughout: the contract's file surface has no
 * parameter for it, and there is nothing here to cancel that would not leave a half-written
 * file behind.
 */
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import type { SandboxSession } from '@pleaseai/sandbox-contract'

/** The file half of the harness session — everything below `run`/`spawn`. */
export type HarnessFileSurface = Pick<
  HarnessV1NetworkSandboxSession,
  'readFile' | 'readBinaryFile' | 'readTextFile' | 'writeFile' | 'writeBinaryFile' | 'writeTextFile'
>

/**
 * How many bytes are turned into characters per `String.fromCharCode` call.
 *
 * The spread form applies the whole array as arguments, and a large array overflows the
 * argument stack — measured under Bun 1.3.14, `String.fromCharCode(...new Uint8Array(n))`
 * survives `n = 500_000` and throws `RangeError` at `n = 1_000_000`. 32 KiB is comfortably
 * under that on every engine and keeps the loop short for the file sizes an agent writes.
 */
const BASE64_CHUNK = 0x8000

export function createFileSurface(sandbox: SandboxSession): HarnessFileSurface {
  async function present(path: string): Promise<boolean> {
    return (await sandbox.exists(path)).exists
  }

  /**
   * A read whose "not found" is the harness's `null` rather than a rejection.
   *
   * The `exists` above is not enough on its own. The two calls are a round trip apart, and the
   * sandbox is a live machine with the agent's own turn running in it: a path that existed for
   * `exists` can be gone before `readFile` asks for it — a checkout, a build that cleans its
   * output, the turn deleting a file it had just listed. Letting that rejection through would
   * hand the agent a failed tool call for what the harness documents as an ordinary `null`.
   *
   * The re-probe is how a not-found is told apart from a real failure, and it is the only way
   * available: `SandboxFiles.readFile` promises just "rejects when the path does not exist" —
   * no error type, code or message a backend must use — so every backend rejects with whatever
   * its own transport threw, and matching on that would be a guess. Asking the sandbox again is
   * a fact about the sandbox. A re-probe that *itself* fails counts as "may exist" and the
   * original error is rethrown, which keeps the safe direction: a swallowed transport failure
   * would report an unreachable sandbox as an empty workspace, and the agent would act on it.
   * The extra call is only ever paid on the failing path.
   */
  async function readingAbsence<T>(path: string, read: () => Promise<T>): Promise<T | null> {
    try {
      return await read()
    }
    catch (cause) {
      if (await present(path).catch(() => true)) {
        throw cause
      }
      return null
    }
  }

  /** The byte stream of a path's contents, or `null` when the path is not there. */
  async function streamOf(path: string): Promise<ReadableStream<Uint8Array> | null> {
    if (!await present(path)) {
      return null
    }
    return readingAbsence(path, async () => (await sandbox.readFile(path, { encoding: 'none' })).content)
  }

  /** The raw bytes, or `null` when the path is not there. */
  async function bytesOf(path: string): Promise<Uint8Array | null> {
    const content = await streamOf(path)
    return content === null ? null : collect(content)
  }

  async function intoDirectoryFor(path: string): Promise<void> {
    const parent = parentDirectory(path)
    if (parent !== undefined) {
      await sandbox.mkdir(parent, { recursive: true })
    }
  }

  return {
    readFile: ({ path }) => streamOf(path),
    readBinaryFile: ({ path }) => bytesOf(path),
    readTextFile: async ({ path, encoding, startLine, endLine }) => {
      const bytes = await bytesOf(path)
      if (bytes === null) {
        return null
      }
      return sliceLines(new TextDecoder(encoding ?? 'utf-8').decode(bytes), startLine, endLine)
    },
    writeFile: async ({ path, content }) => {
      await intoDirectoryFor(path)
      await sandbox.writeFile(path, content)
    },
    writeBinaryFile: async ({ path, content }) => {
      await intoDirectoryFor(path)
      await sandbox.writeFile(path, toBase64(content), { encoding: 'base64' })
    },
    writeTextFile: async ({ path, content, encoding }) => {
      if (encoding !== undefined && encoding !== 'utf-8' && encoding !== 'utf8') {
        throw new Error(
          `cannot write '${path}' as '${encoding}': the sandbox contract encodes text as UTF-8 only`,
        )
      }
      await intoDirectoryFor(path)
      await sandbox.writeFile(path, content, { encoding: 'utf-8' })
    },
  }
}

/**
 * The directory a path lives in, or `undefined` when the path names no directory at all.
 *
 * POSIX-only by construction: sandbox paths are container paths, and the contract's callers
 * spell them with forward slashes whatever host the orchestrator runs on.
 */
export function parentDirectory(path: string): string | undefined {
  const cut = path.lastIndexOf('/')
  if (cut < 0) {
    return undefined
  }
  return cut === 0 ? '/' : path.slice(0, cut)
}

/**
 * A 1-based, inclusive line range, as the harness documents it.
 *
 * A range that names neither end returns the text untouched rather than round-tripping it
 * through `split`/`join`. `startLine` below 1 is out of contract and clamped to the first
 * line: passed on as a negative index it would mean *the last* lines, which is the one
 * wrong answer that still looks like a successful read.
 */
export function sliceLines(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) {
    return text
  }
  const lines = text.split('\n')
  const from = Math.max(0, (startLine ?? 1) - 1)
  return lines.slice(from, endLine ?? lines.length).join('\n')
}

/** Concatenate a byte stream into one array. */
async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

/** Bytes → base64, chunked so a large payload does not overflow the argument stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK))
  }
  return btoa(binary)
}
