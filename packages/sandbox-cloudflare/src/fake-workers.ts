/**
 * Stand-ins for the two modules that resolve only inside a Worker build.
 */

export interface FakeFs {
  files: Map<string, Uint8Array>
  dirs: Set<string>
}

function fileError(code: string, path: string): Error {
  return Object.assign(new Error(`${code}: ${path}`), { name: 'SandboxFileError', code })
}

function parentOf(path: string): string {
  const parent = path.slice(0, path.lastIndexOf('/'))
  return parent === '' ? '/' : parent
}

class FakeFiles {
  private readonly fs: FakeFs

  constructor(container: { fs: FakeFs }) {
    this.fs = container.fs
  }

  async readFile(path: string): Promise<Response> {
    const bytes = this.fs.files.get(path)
    if (bytes === undefined) {
      throw fileError('ENOENT', path)
    }
    return new Response(bytes.slice())
  }

  async writeFile(path: string, content: string | Uint8Array | ReadableStream<Uint8Array>): Promise<void> {
    if (!this.fs.dirs.has(parentOf(path))) {
      throw fileError('ENOENT', path)
    }
    const bytes = typeof content === 'string'
      ? new TextEncoder().encode(content)
      : content instanceof Uint8Array ? content : new Uint8Array(await new Response(content).arrayBuffer())
    this.fs.files.set(path, bytes)
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    if (options?.recursive !== true && !this.fs.dirs.has(parentOf(path))) {
      throw fileError('ENOENT', path)
    }
    for (let at = path; at !== '/'; at = parentOf(at)) {
      this.fs.dirs.add(at)
    }
  }

  async stat(path: string): Promise<{ type: string }> {
    if (this.fs.files.has(path)) {
      return { type: 'file' }
    }
    if (this.fs.dirs.has(path)) {
      return { type: 'directory' }
    }
    throw fileError(path.startsWith('/forbidden') ? 'EACCES' : 'ENOENT', path)
  }
}

export const sandboxModule = {
  Files: FakeFiles,
  SandboxFileError: {
    is: (cause: unknown): boolean => cause instanceof Error && cause.name === 'SandboxFileError',
  },
}

export const workersModule = {
  DurableObject: class {
    ctx: unknown
    env: unknown
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx
      this.env = env
    }
  },
}
