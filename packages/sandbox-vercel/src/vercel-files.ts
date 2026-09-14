/**
 * The contract's file surface, over Vercel.
 *
 * `@amond-ai/sandbox` declares files in Cloudflare's shape — positional path,
 * encoding-selected overloads — because that keeps the incumbent backend free of any mapping
 * layer. Vercel's is different in every one of those respects, so this is where the difference
 * is paid, exactly as the contract's own note says it should be.
 *
 * Four mismatches are worth naming, because each is a decision rather than a transcription:
 *
 * - Vercel reads *bytes* (`readFileToBuffer`), never "text in the encoding you asked for", so
 *   the decoded read decodes here. `'base64'` is produced from the bytes rather than requested
 *   from the API, which has no such format.
 * - There is no streaming read this package may use: `readFile` returns a `NodeJS.ReadableStream`
 *   and this has to run wherever a `fetch` does. So `encoding: 'none'` collects the bytes and
 *   wraps them in a one-chunk `ReadableStream` — the shape the contract asks for, without the
 *   runtime the SDK's stream would need, and at the memory cost of holding the file.
 * - `readFileToBuffer` answers `null` for a file that is not there, while the contract says
 *   `readFile` **rejects** for one. The absence is therefore turned into a named error rather
 *   than a `null` the caller would have to guess the meaning of — callers wanting
 *   absence-as-value pair the read with {@link pathExists}, which is what the contract says.
 * - `writeFiles` takes an array and `mkDir` is not recursive, so both are adapted: one file per
 *   call, and `mkdir -p` through the shell.
 */
import type { SandboxFileContent, SandboxFiles, SandboxFileStream } from '@amond-ai/sandbox'
import type { VercelSandboxLike } from './vercel-surface'
import { WRAPPER_SHELL } from './journal'

/** The read found nothing — the contract's rejection, with an identity a caller can test. */
export class VercelFileNotFoundError extends Error {
  readonly path: string

  constructor(path: string) {
    super(`no such file in the sandbox: '${path}'`)
    this.name = 'VercelFileNotFoundError'
    this.path = path
  }
}

function decode(bytes: Uint8Array, encoding: string | undefined): SandboxFileContent {
  if (encoding === 'base64') {
    let binary = ''
    for (const byte of bytes) {
      binary += String.fromCharCode(byte)
    }
    return { content: btoa(binary), encoding: 'base64' }
  }
  return { content: new TextDecoder().decode(bytes), encoding: 'utf-8' }
}

function bytesOfBase64(content: string): Uint8Array {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at++) {
    bytes[at] = binary.charCodeAt(at)
  }
  return bytes
}

export function createVercelFiles(sandbox: VercelSandboxLike): SandboxFiles {
  async function read(path: string): Promise<Uint8Array> {
    const bytes = await sandbox.readFileToBuffer({ path })
    if (bytes === null) {
      throw new VercelFileNotFoundError(path)
    }
    return bytes
  }

  const readFile = (async (
    path: string,
    options?: { encoding?: string },
  ): Promise<SandboxFileStream | SandboxFileContent> => {
    const bytes = await read(path)
    if (options?.encoding === 'none') {
      // One chunk, because there is nothing to stream *from*: the SDK's streaming read is a Node
      // stream this package may not name, so the bytes are already in hand by the time the
      // caller asks for a stream. The shape is what the contract wants; the laziness is not
      // available at any price here.
      return {
        content: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes)
            controller.close()
          },
        }),
      }
    }
    return decode(bytes, options?.encoding)
  }) as SandboxFiles['readFile']

  return {
    readFile,
    writeFile: async (path, content, options) => {
      if (typeof content !== 'string') {
        // Vercel has no chunked write this runtime can reach, so the stream is collected here.
        return sandbox.writeFiles([{ path, content: new Uint8Array(await new Response(content).arrayBuffer()) }])
      }
      // A base64 write means "these are the bytes", not "store this text": handing the string
      // through unchanged would persist the encoding rather than the file.
      const body = options?.encoding === 'base64' ? bytesOfBase64(content) : content
      return sandbox.writeFiles([{ path, content: body }])
    },
    // Always `-p`, never `sandbox.mkDir`, which creates one level: a non-recursive request is
    // satisfied by a recursive create, never the other way round, and a caller asking for a
    // nested path would otherwise fail on a parent it had no reason to think about.
    mkdir: async (path) => {
      const made = await sandbox.runCommand({ cmd: WRAPPER_SHELL, args: ['-c', 'mkdir -p -- "$1"', 'sh', path] })
      if (made.exitCode !== 0) {
        throw new Error(`could not create '${path}' in the sandbox: mkdir exited ${String(made.exitCode)}`)
      }
    },
  }
}

/**
 * Whether a path is there — `false` only when the sandbox said so.
 *
 * A clean non-zero exit from `test -e` is absence. A rejected `runCommand` is a dead transport,
 * and it propagates: the harness decides from this whether the bridge bundle needs installing,
 * so absence-on-failure would reinstall it on every turn — and, worse, would read a sandbox
 * nobody can reach as an empty one.
 */
export async function pathExists(sandbox: VercelSandboxLike, path: string): Promise<boolean> {
  const probed = await sandbox.runCommand({ cmd: WRAPPER_SHELL, args: ['-c', 'test -e "$1"', 'sh', path] })
  return probed.exitCode === 0
}
