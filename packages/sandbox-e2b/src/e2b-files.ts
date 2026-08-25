/**
 * The contract's file surface, over e2b.
 *
 * `@pleaseai/sandbox-contract` declares files in Cloudflare's shape — positional path,
 * encoding-selected overloads — because that keeps the incumbent backend free of any mapping
 * layer. e2b's is different in every one of those respects, so this is where the difference
 * is paid, exactly as the contract's own note says it should be.
 *
 * Two mismatches are worth naming, because each is a decision rather than a transcription:
 *
 * - e2b reads bytes or a stream, never "text in the encoding you asked for", so the decoded
 *   read decodes here. `'base64'` is produced from the bytes rather than requested from e2b,
 *   which has no such format.
 * - e2b writes a path in one call and has no streaming write, so a stream is collected first.
 *   That is a real memory cost the Cloudflare backend does not pay, and it is why the
 *   streaming *read* is passed straight through instead of being collected the same way.
 */
import type { SandboxFileContent, SandboxFiles, SandboxFileStream } from '@pleaseai/sandbox-contract'
import type { E2bSandboxLike } from './e2b-surface'

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

export function createE2bFiles(sandbox: E2bSandboxLike): SandboxFiles {
  const readFile = (async (
    path: string,
    options?: { encoding?: string },
  ): Promise<SandboxFileStream | SandboxFileContent> => {
    if (options?.encoding === 'none') {
      return { content: await sandbox.files.read(path, { format: 'stream' }) }
    }
    return decode(await sandbox.files.read(path, { format: 'bytes' }), options?.encoding)
  }) as SandboxFiles['readFile']

  return {
    readFile,
    writeFile: async (path, content, options) => {
      if (typeof content !== 'string') {
        // e2b has no streaming write, so the stream is collected here. That is a real memory
        // cost the Cloudflare backend does not pay, and it is why the streaming *read* is
        // passed straight through rather than being collected the same way.
        return sandbox.files.write(path, await new Response(content).arrayBuffer())
      }
      if (options?.encoding === 'base64') {
        // A base64 write means "these are the bytes", not "store this text": handing the
        // string through unchanged would persist the encoding rather than the file.
        const binary = atob(content)
        const bytes = new Uint8Array(binary.length)
        for (let at = 0; at < binary.length; at++) {
          bytes[at] = binary.charCodeAt(at)
        }
        return sandbox.files.write(path, bytes.buffer as ArrayBuffer)
      }
      return sandbox.files.write(path, content)
    },
    // e2b's `makeDir` already creates parents, so `recursive` needs no translation — and a
    // non-recursive request is satisfied by a recursive create, never the other way round.
    mkdir: async path => sandbox.files.makeDir(path),
  }
}
