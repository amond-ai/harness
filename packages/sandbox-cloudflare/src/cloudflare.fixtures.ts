/**
 * A `HarnessSandbox` over a scripted container, and a session over that object.
 *
 * Test files must register the module stand-ins before importing this:
 * `vi.mock('cloudflare:workers', …)` and `vi.mock('@cloudflare/sandbox', …)` from `fake-workers.ts`.
 */
import type { SandboxSession } from '@amond-ai/sandbox'
import type { FakeFs } from './fake-workers'
import type { HarnessSandboxRpc } from './rpc'
import type { CloudflareSessionOptions } from './session'
import { vi } from 'vitest'
import { HarnessSandbox } from './durable-object'
import { KILL, LIST, PREPARE, PROCESS_ROOT, READ_SLICE, RUN, SIZE, STATUS } from './process-scripts'
import { createCloudflareSession } from './session'

export const AT = '2026-10-22T00:00:00.000Z'

export interface FakeProcess {
  phase: 'starting' | 'running' | 'exited' | 'lost'
  pid?: number
  code?: number
  timedOut: boolean
  stdout: Uint8Array
  stderr: Uint8Array
  meta: string
}

export interface FakeContainer {
  running: boolean
  images: Record<string, string>
  fs: FakeFs
  processes: Map<string, FakeProcess>
  execs: { argv: string[], options?: ContainerExecOptions }[]
  kills: { dir: string, signal: string }[]
  runPhase: FakeProcess['phase']
  start: ReturnType<typeof vi.fn>
  destroy: ReturnType<typeof vi.fn>
  setInactivityTimeout: ReturnType<typeof vi.fn>
  getTcpPort: ReturnType<typeof vi.fn>
  exec: (argv: string[], options?: ContainerExecOptions) => Promise<ExecProcess>
}

interface FakeStorage {
  data: Map<string, unknown>
  alarm: number | null
}

function reply(stdout: string | Uint8Array = '', exitCode = 0): ExecProcess {
  const bytes = typeof stdout === 'string' ? new TextEncoder().encode(stdout) : stdout
  return {
    output: async () => ({ stdout: bytes.slice().buffer, stderr: new ArrayBuffer(0), exitCode }),
  } as unknown as ExecProcess
}

function reportLines(process: FakeProcess | undefined): string {
  if (process === undefined) {
    return 'missing\n\n\n'
  }
  const status = process.phase === 'running'
    ? `running ${String(process.pid)}`
    : process.phase === 'exited' ? `exited ${String(process.code)}` : process.phase
  return `${status}\n${process.timedOut ? 'timed-out' : ''}\n${process.meta}\n`
}

function logOf(container: FakeContainer, file: string): Uint8Array | undefined {
  const slash = file.lastIndexOf('/')
  const process = container.processes.get(file.slice(0, slash))
  const name = file.slice(slash + 1)
  return name === 'stdout.log' ? process?.stdout : name === 'stderr.log' ? process?.stderr : undefined
}

export function fakeContainer(): FakeContainer {
  let nextPid = 100
  const container: FakeContainer = {
    running: false,
    images: { sandbox: 'registry.example/sandbox:1' },
    fs: { files: new Map(), dirs: new Set(['/']) },
    processes: new Map(),
    execs: [],
    kills: [],
    runPhase: 'running',
    start: vi.fn(() => {
      container.running = true
    }),
    destroy: vi.fn(async () => {
      container.running = false
    }),
    setInactivityTimeout: vi.fn(async () => {}),
    getTcpPort: vi.fn(),
    exec: async (argv, options) => {
      container.execs.push({ argv, options })
      const [script, , ...args] = argv.slice(2)
      if (argv[0] === 'rm') {
        container.processes.delete(argv[2]!)
        return reply()
      }
      switch (script) {
        case PREPARE: {
          const [, dir = '', meta = ''] = args
          if (container.processes.has(dir)) {
            return reply('', 1)
          }
          container.processes.set(dir, {
            phase: 'starting',
            timedOut: false,
            stdout: new Uint8Array(),
            stderr: new Uint8Array(),
            meta,
          })
          return reply()
        }
        case RUN: {
          const process = container.processes.get(args[0]!)!
          process.phase = container.runPhase
          process.pid = container.runPhase === 'running' ? nextPid++ : undefined
          return reply()
        }
        case STATUS:
          return reply(reportLines(container.processes.get(args[0]!)))
        case LIST:
          return reply([...container.processes]
            .map(([dir, process]) => `${dir.slice(dir.lastIndexOf('/') + 1)}\n${reportLines(process)}`)
            .join(''))
        case READ_SLICE: {
          const [file = '', offset = '0', limit = '0'] = args
          const log = logOf(container, file) ?? new Uint8Array()
          return reply(log.slice(Number(offset), Number(offset) + Number(limit)))
        }
        case SIZE:
          return reply(`${String(logOf(container, args[0]!)?.length ?? 0)}\n`)
        case KILL: {
          const [dir = '', signal = ''] = args
          const process = container.processes.get(dir)
          if (process?.phase === 'exited') {
            return reply('', 4)
          }
          if (process?.phase !== 'running') {
            return reply('', 3)
          }
          container.kills.push({ dir, signal })
          return reply()
        }
        default:
          throw new Error(`unscripted exec: ${argv.join(' ')}`)
      }
    },
  }
  return container
}

export function fakeStorage(): FakeStorage & DurableObjectStorage {
  const storage: FakeStorage = { data: new Map(), alarm: null }
  return Object.assign(storage, {
    put: async (key: string, value: unknown) => {
      storage.data.set(key, value)
    },
    get: async (key: string) => storage.data.get(key),
    list: async (options?: { prefix?: string }) =>
      new Map([...storage.data].filter(([key]) => key.startsWith(options?.prefix ?? ''))),
    delete: async (keys: string | string[]) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        storage.data.delete(key)
      }
    },
    setAlarm: async (at: number) => {
      storage.alarm = at
    },
    deleteAlarm: async () => {
      storage.alarm = null
    },
  }) as unknown as FakeStorage & DurableObjectStorage
}

export function fakeSandbox(container = fakeContainer()) {
  const storage = fakeStorage()
  const ctx = {
    container,
    storage,
    blockConcurrencyWhile: async <T>(work: () => Promise<T>) => work(),
  } as unknown as DurableObjectState
  const sandbox = new HarnessSandbox(ctx, {})
  let minted = 0
  const session = (options?: CloudflareSessionOptions): SandboxSession =>
    createCloudflareSession(sandbox as HarnessSandboxRpc, {
      newProcessId: () => `run-${String(++minted)}`,
      now: () => AT,
      pollIntervalMs: 1,
      followIntervalMs: 1,
      livenessIntervalMs: 0,
      ...options,
    })
  return { container, storage, sandbox, session }
}

export function processOf(container: FakeContainer, id: string): FakeProcess {
  const process = container.processes.get(`${PROCESS_ROOT}/${id}`)
  if (process === undefined) {
    throw new Error(`no process '${id}' in the fake container`)
  }
  return process
}

export function endProcess(container: FakeContainer, id: string, code: number, timedOut = false): void {
  Object.assign(processOf(container, id), { phase: 'exited', code, timedOut })
}

export function writeLog(container: FakeContainer, id: string, stream: 'stdout' | 'stderr', text: string): void {
  const process = processOf(container, id)
  const added = new TextEncoder().encode(text)
  const joined = new Uint8Array(process[stream].length + added.length)
  joined.set(process[stream])
  joined.set(added, process[stream].length)
  process[stream] = joined
}

export function leapingClock(stepMs: number): () => number {
  let at = 0
  return () => (at += stepMs)
}

export async function drain<T>(stream: ReadableStream<T>): Promise<T[]> {
  const events: T[] = []
  for await (const event of stream as unknown as AsyncIterable<T>) {
    events.push(event)
  }
  return events
}
