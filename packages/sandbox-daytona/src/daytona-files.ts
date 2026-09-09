/**
 * The contract's file surface, over Daytona.
 *
 * `@amond-ai/sandbox` declares files in Cloudflare's shape — positional path,
 * encoding-selected overloads — because that keeps the incumbent backend free of any mapping
 * layer. Daytona's is different in every one of those respects, so this is where the difference
 * is paid, exactly as the contract's own note says it should be.
 *
 * Three mismatches are worth naming, because each is a decision rather than a transcription:
 *
 * - Daytona reads *bytes* (`downloadFile`, a `Buffer` in Node), never "text in the encoding you
 *   asked for", so the decoded read decodes here. `'base64'` is produced from the bytes rather
 *   than requested from Daytona, which has no such format.
 * - The write goes through `uploadFileStream`, not `uploadFile`. `uploadFile(string, path)`
 *   treats its first argument as a *local file path* rather than as content (research note 035
 *   §4), and its `Buffer` overload would put `node:buffer` in a package that must run wherever a
 *   `WebSocket` does. `uploadFileStream` takes a `Uint8Array`.
 * - There is no streaming *read*: `downloadFileStream` returns a Node `Readable`, and the SDK's
 *   own JSDoc says serverless callers should use `downloadFile`. So `encoding: 'none'` wraps the
 *   downloaded bytes in a one-chunk `ReadableStream` — the shape the contract asks for, without
 *   the runtime the SDK's stream would need.
 */
import type { SandboxFileContent, SandboxFiles, SandboxFileStream } from '@amond-ai/sandbox'
import type { DaytonaSandboxLike } from './daytona-surface'

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

export function createDaytonaFiles(sandbox: DaytonaSandboxLike): SandboxFiles {
  const readFile = (async (
    path: string,
    options?: { encoding?: string },
  ): Promise<SandboxFileStream | SandboxFileContent> => {
    const bytes = await sandbox.fs.downloadFile(path)
    if (options?.encoding === 'none') {
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
        // Daytona has no chunked write this runtime can reach, so the stream is collected here.
        return sandbox.fs.uploadFileStream(new Uint8Array(await new Response(content).arrayBuffer()), path)
      }
      // A base64 write means "these are the bytes", not "store this text": handing the string
      // through unchanged would persist the encoding rather than the file.
      const bytes = options?.encoding === 'base64' ? bytesOfBase64(content) : new TextEncoder().encode(content)
      return sandbox.fs.uploadFileStream(bytes, path)
    },
    // Daytona's `createFolder` creates parents, so `recursive` needs no translation — and a
    // non-recursive request is satisfied by a recursive create, never the other way round. The
    // mode is required by the API and has no contract counterpart; `755` is what a directory the
    // sandbox's own shell writes into needs.
    mkdir: async path => sandbox.fs.createFolder(path, '755'),
  }
}
