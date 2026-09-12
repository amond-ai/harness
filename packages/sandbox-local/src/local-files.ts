/**
 * The contract's file surface, over the host filesystem.
 *
 * `@amond-ai/sandbox` declares files in Cloudflare's shape — positional path,
 * encoding-selected overloads — because that keeps the incumbent backend free of a mapping
 * layer, and every other backend pays the difference here. What this one also pays is the
 * *path*: a caller of this contract writes container-absolute paths, and on a machine that is
 * not a container those name real places. Every path is resolved inside the sandbox's working
 * directory by {@link resolveWithin}, so `/etc/passwd` reads the sandbox's copy or nothing at
 * all rather than the host's.
 *
 * That is a mapping, not a boundary. It normalises the path it is handed; it does not follow
 * symlinks, and it has no say at all over where a command started by `exec` reads and writes.
 * The package README states the consequence plainly.
 */
import type { SandboxFileContent, SandboxFiles, SandboxFileStream } from '@amond-ai/sandbox'
import type { JournalIo } from './journal-io'
import type { LocalHost } from './local-surface'
import { parentOf, resolveWithin } from './paths'

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

function encodeBase64(content: string): Uint8Array {
  const binary = atob(content)
  const bytes = new Uint8Array(binary.length)
  for (let at = 0; at < binary.length; at++) {
    bytes[at] = binary.charCodeAt(at)
  }
  return bytes
}

export function createLocalFiles(host: LocalHost, io: JournalIo, root: string): SandboxFiles {
  const readFile = (async (
    path: string,
    options?: { encoding?: string },
  ): Promise<SandboxFileStream | SandboxFileContent> => {
    const resolved = resolveWithin(root, path)
    // Absence is a rejection here, by contract — callers that want absence as a value pair
    // this with `exists`. Asked before the read rather than inferred from an empty one,
    // because an empty file is a legitimate answer and a missing one is not.
    if (await host.size(resolved) === undefined) {
      throw new Error(`no such file: '${path}'`)
    }
    if (options?.encoding === 'none') {
      const chunks = io.streamFile(resolved)
      return {
        content: new ReadableStream<Uint8Array>({
          async pull(controller) {
            const { done, value } = await chunks.next()
            if (done) {
              controller.close()
              return
            }
            controller.enqueue(value)
          },
          async cancel(reason) {
            await chunks.return(reason)
          },
        }),
      }
    }
    const { data } = await host.readSlice(resolved, 0)
    return decode(data, options?.encoding)
  }) as SandboxFiles['readFile']

  return {
    readFile,
    writeFile: async (path, content, options) => {
      const resolved = resolveWithin(root, path)
      // The parent is created first, because both sibling backends create one: e2b's
      // `files.write` and the Cloudflare client both write a path into a tree that does not
      // exist yet, and a caller that works on those and fails here with a bare `ENOENT` would
      // have found a difference between backends where the contract promises none.
      await host.mkdir(parentOf(resolved))
      if (typeof content !== 'string') {
        // Collected rather than piped: the host surface writes a path in one call, and a
        // streaming write would be a second primitive for the one caller that has none.
        await host.writeFile(resolved, new Uint8Array(await new Response(content).arrayBuffer()))
        return
      }
      // A base64 write means "these are the bytes", not "store this text": handing the string
      // through unchanged would persist the encoding rather than the file.
      await host.writeFile(
        resolved,
        options?.encoding === 'base64' ? encodeBase64(content) : new TextEncoder().encode(content),
      )
    },
    // The host creates parents, so `recursive` needs no translation — and a non-recursive
    // request is satisfied by a recursive create, never the other way round.
    mkdir: async path => host.mkdir(resolveWithin(root, path)),
  }
}
