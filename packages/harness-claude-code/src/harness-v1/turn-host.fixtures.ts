/**
 * A fake turn host and the container it runs in — everything the `sdk` driver reaches for that a
 * test cannot have: a bridge process, a socket, and a sandbox session to exec into.
 *
 * A *journal* rather than a script, because that is what makes the round boundary testable at
 * all: the host stamps every outbound frame with a sequence and replays from whatever cursor an
 * `resume` asks for, so a slice that stopped halfway is continued by attaching again rather than
 * by re-running anything. Frames are replayed one macrotask apart so a consumer can stop reading
 * in the middle of a turn, which is exactly what `doSuspendTurn` does.
 *
 * Not a `*.test.ts` file, so vitest's `include` skips it; it decides nothing, and every frame it
 * sends is the test's.
 */
import type { WsLike } from '@amond-ai/harness-transport'
import type {
  ProcessLogEvent,
  SandboxCommand,
  SandboxProcessHandle,
  SandboxProvider,
  SandboxSession,
} from '@amond-ai/sandbox'

/** One journaled frame: what the host sent, and the sequence it sent it at. */
interface JournaledFrame {
  seq: number
  frame: Record<string, unknown>
}

export interface FakeTurnHost {
  /** Every `start` frame the driver sent — the turn's prompt, session id and policy. */
  readonly starts: Record<string, unknown>[]
  /** Every `resume` cursor an attach round asked from. */
  readonly attaches: number[]
  /** Every process id the driver killed, in order. */
  readonly kills: string[]
  provider: SandboxProvider
  openSocket: (url: string) => Promise<WsLike>
}

export interface FakeTurnHostOptions {
  /** The turn's frames, in order, as the host journals them after `bridge-started`. */
  frames: (prompt: string) => Record<string, unknown>[]
}

export function createFakeTurnHost(options: FakeTurnHostOptions): FakeTurnHost {
  const starts: Record<string, unknown>[] = []
  const attaches: number[] = []
  const kills: string[] = []
  let journal: JournaledFrame[] = []
  let nextSeq = 1

  const journalFrame = (frame: Record<string, unknown>): JournaledFrame => {
    const stamped = { seq: nextSeq, frame: { ...frame, seq: nextSeq } }
    nextSeq += 1
    journal.push(stamped)
    return stamped
  }

  const openSocket = async (): Promise<WsLike> => {
    const connection = createConnection()
    connection.onCommand((message) => {
      if (message.type === 'start') {
        starts.push(message)
        journal = []
        nextSeq = 1
        connection.deliver(journalFrame({ type: 'bridge-started' }).frame)
        for (const frame of options.frames(String(message.prompt))) {
          journalFrame(frame)
        }
        return
      }
      if (message.type === 'resume') {
        const since = Number(message.lastSeenEventId ?? 0)
        attaches.push(since)
        connection.replay(journal.filter(entry => entry.seq > since).map(entry => entry.frame))
      }
    })
    connection.deliver({ type: 'bridge-hello', state: 'waiting', lastSeq: 0 })
    return connection.socket
  }

  return { starts, attaches, kills, provider: fakeProvider(kills), openSocket }
}

/** One socket, with the queue-until-listening behaviour `ws-shim` has. */
function createConnection() {
  const listeners = new Map<string, ((...args: never[]) => void)[]>()
  const queued: string[] = []
  let onCommand: (message: Record<string, unknown>) => void = () => {}
  let closed = false

  const fire = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      (listener as (...values: unknown[]) => void)(...args)
    }
  }
  const deliver = (frame: Record<string, unknown>): void => {
    const text = JSON.stringify(frame)
    if ((listeners.get('message') ?? []).length === 0) {
      queued.push(text)
      return
    }
    fire('message', text)
  }
  const replay = (frames: Record<string, unknown>[]): void => {
    const rest = [...frames]
    const tick = (): void => {
      const next = rest.shift()
      if (closed || next === undefined) {
        return
      }
      deliver(next)
      setTimeout(tick, 0)
    }
    setTimeout(tick, 0)
  }

  const socket: WsLike = {
    on: ((event: string, listener: (...args: never[]) => void) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
      if (event === 'message') {
        for (const text of queued.splice(0)) {
          fire('message', text)
        }
      }
    }) as WsLike['on'],
    off: (event, listener) => {
      listeners.set(event, (listeners.get(event) ?? []).filter(registered => registered !== listener))
    },
    send: (data) => {
      onCommand(JSON.parse(data) as Record<string, unknown>)
    },
    close: () => {
      closed = true
    },
    terminate: () => {
      closed = true
    },
  }

  return {
    socket,
    deliver,
    replay,
    onCommand: (handler: (message: Record<string, unknown>) => void) => {
      onCommand = handler
    },
  }
}

/** The container: one host process, and the four file operations the start path makes. */
function fakeProvider(kills: string[]): SandboxProvider {
  const files = new Map<string, string>()
  const processes = new Map<string, SandboxProcessHandle>()

  const handleFor = (id: string, command: SandboxCommand): SandboxProcessHandle => {
    // The readiness read consumes this once; a second poll finds the announcement already read.
    const batches = [`${JSON.stringify({ type: 'bridge-ready', port: 41_001 })}\n`]
    return {
      id,
      pid: 1,
      command,
      status: async () => ({ id, pid: 1, command, state: 'running', startedAt: new Date().toISOString() }),
      logs: async () => stdout(batches.shift()),
      waitForExit: async () => ({ code: 0, timedOut: false }),
      kill: async () => {
        kills.push(id)
      },
    } as unknown as SandboxProcessHandle
  }

  const session = {
    exec: async (command: SandboxCommand) => {
      const handle = handleFor('host-1', command)
      processes.set('host-1', handle)
      return handle
    },
    mkdir: async () => {},
    writeFile: async (path: string, content: string) => {
      files.set(path, content)
    },
    exists: async (path: string) => ({ exists: files.has(path) }),
    readFile: async (path: string) => ({ content: files.get(path) ?? '' }),
    getProcess: async (id: string) => processes.get(id) ?? null,
    listProcesses: async () => await Promise.all([...processes.values()].map(async handle => await handle.status())),
  } as unknown as SandboxSession

  return {
    backend: 'cloudflare',
    session: () => session,
    portEndpoint: async (_id: string, port: number) => ({ url: `ws://127.0.0.1:${String(port)}/` }),
  } as unknown as SandboxProvider
}

/** One stdout batch, as the readiness read consumes it. */
function stdout(text: string | undefined): ReadableStream<ProcessLogEvent> {
  return new ReadableStream({
    start(controller) {
      if (text !== undefined) {
        controller.enqueue({
          type: 'stdout',
          cursor: '1',
          timestamp: new Date().toISOString(),
          data: new TextEncoder().encode(text),
        } as ProcessLogEvent)
      }
      controller.close()
    },
  })
}
