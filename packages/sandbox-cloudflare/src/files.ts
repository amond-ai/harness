/**
 * The contract's file surface, over `HarnessSandbox`'s file methods.
 *
 * The default encoding of a read is `utf-8`; a caller that wants bytes intact names `'base64'`
 * or streams with `'none'`.
 */
import type { SandboxFileContent, SandboxFiles, SandboxFileStream } from '@amond-ai/sandbox'
import type { HarnessSandboxRpc } from './rpc'

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

export function createCloudflareFiles(sandbox: HarnessSandboxRpc): SandboxFiles {
  const readFile = (async (
    path: string,
    options?: { encoding?: string },
  ): Promise<SandboxFileStream | SandboxFileContent> => {
    if (options?.encoding === 'none') {
      return { content: await sandbox.readFileStream(path) }
    }
    return decode(await sandbox.readFile(path), options?.encoding)
  }) as SandboxFiles['readFile']

  return {
    readFile,
    writeFile: async (path, content, options) => {
      const body = typeof content === 'string' && options?.encoding === 'base64' ? bytesOfBase64(content) : content
      await sandbox.writeFile(path, body)
    },
    mkdir: async (path, options) => sandbox.mkdir(path, options?.recursive === true),
  }
}
