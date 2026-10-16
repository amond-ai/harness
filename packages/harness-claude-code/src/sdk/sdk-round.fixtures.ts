/**
 * A scripted attach round: the socket a round dials, the sandbox session it probes and kills
 * through, and the clocks it is judged on.
 *
 * Adapted from the extraction source's worker suite (`turn-host.fakes.ts`), reduced to what
 * `runAttachRound` reaches for — a round never sends `start`, so there is no readiness read and
 * no exec here. Everything is scripted frame by frame by the test that wants it: a connection
 * can be answered, dropped, or never completed, and a probe of the host can be hooked to land a
 * suspend at an exact point.
 *
 * Not a `*.test.ts` file, so vitest's `include` skips it; it decides nothing.
 */
import type { WsLike } from '@amond-ai/harness-transport'
import type { ProcessStatus, SandboxCommand, SandboxProcessHandle, SandboxSession } from '@amond-ai/sandbox'
import type { TurnDriverConfig } from '../config'
import type { LiveMirror } from '../mirror'
import type { TurnHandle } from '../turn-driver'
import { vi } from 'vitest'

/** The handle every round test attaches to; no `bridgeStateDir`, so a gone host reads no journal. */
export const HANDLE: TurnHandle = {
  processId: 'host-1',
  startedAtMs: 1_000_000,
  port: 41_001,
  token: 'tok',
}

/** Only the thresholds a round reads; sampling in milliseconds, the rest decided by the test. */
export function fakeConfig(overrides: Partial<TurnDriverConfig> = {}): TurnDriverConfig {
  return {
    livenessSampleIntervalMs: 100,
    watchdogTimeoutMs: 60 * 60 * 1000,
    livenessWindowMs: 1_000,
    ...overrides,
  } as TurnDriverConfig
}

/** One connection to the fake host, as the test drives it. */
export interface FakeConnection {
  /** Every command the round sent, parsed. */
  readonly sent: Record<string, unknown>[]
  /** Queue one frame for the round to read; objects are serialised, strings sent verbatim. */
  emit: (frame: unknown) => void
  /** Close the socket from the host's side — a bridge that died, or a dropped connection. */
  drop: () => void
  /** Whether the round closed this socket. */
  readonly closed: boolean
}

export interface FakeTurnHostScript {
  /** Skip the handshake, so the round sees a bridge that never greets it. */
  greet?: false
  /** Called for every command the round sends, so a test can answer it. */
  onSend?: (message: Record<string, unknown>, connection: FakeConnection, index: number) => void
  /** What the greeting reports the bridge is doing; `waiting` unless a test says otherwise. */
  helloState?: 'waiting' | 'running' | 'done'
  /** The greeting's cursor — how many frames this bridge has ever emitted; `0` by default. */
  helloLastSeq?: number
  /** The greeting's `capabilities`; none by default, which is a host older than every one. */
  helloCapabilities?: Record<string, unknown>
}

export interface FakeTurnHost {
  connect: () => Promise<WsLike>
  readonly connections: FakeConnection[]
}

export function createFakeTurnHost(script: FakeTurnHostScript = {}): FakeTurnHost {
  const connections: FakeConnection[] = []
  return {
    connections,
    connect: async () => {
      const { connection, socket } = createConnection(script, connections.length)
      connections.push(connection)
      if (script.greet !== false) {
        connection.emit({
          type: 'bridge-hello',
          state: script.helloState ?? 'waiting',
          lastSeq: script.helloLastSeq ?? 0,
          ...(script.helloCapabilities === undefined ? {} : { capabilities: script.helloCapabilities }),
        })
      }
      return socket
    },
  }
}

/** Every `interrupt` the round sent, across all of its connections. */
export function interruptsSent(host: FakeTurnHost): Record<string, unknown>[] {
  return host.connections.flatMap(connection => connection.sent).filter(message => message.type === 'interrupt')
}

/**
 * One socket. Frames are queued until a `message` handler exists, the way `ws-shim` does: the
 * channel registers its listeners after the opener resolves, and a frame emitted before that
 * must not be lost to the gap.
 */
function createConnection(
  script: FakeTurnHostScript,
  index: number,
): { connection: FakeConnection, socket: WsLike } {
  const handlers = new Map<string, ((...args: never[]) => void)[]>()
  const pending: string[] = []
  const sent: Record<string, unknown>[] = []
  let closed = false

  const fire = (event: string, ...args: unknown[]): void => {
    for (const handler of handlers.get(event) ?? []) {
      (handler as (...values: unknown[]) => void)(...args)
    }
  }

  const connection: FakeConnection = {
    sent,
    emit: (frame) => {
      const text = typeof frame === 'string' ? frame : JSON.stringify(frame)
      if ((handlers.get('message') ?? []).length === 0) {
        pending.push(text)
        return
      }
      fire('message', text)
    },
    drop: () => {
      closed = true
      fire('close', 1006, { code: 1006, reason: '' })
    },
    get closed() {
      return closed
    },
  }

  const socket: WsLike = {
    on: ((event: string, handler: (...args: never[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
      if (event === 'message') {
        for (const text of pending.splice(0)) {
          fire('message', text)
        }
      }
    }) as WsLike['on'],
    off: (event, handler) => {
      handlers.set(event, (handlers.get(event) ?? []).filter(registered => registered !== handler))
    },
    send: (data) => {
      const message = JSON.parse(data) as Record<string, unknown>
      sent.push(message)
      script.onSend?.(message, connection, index)
    },
    close: () => {
      closed = true
    },
    terminate: () => {
      closed = true
    },
  }
  return { connection, socket }
}

/** A turn host process, with only the members a round touches. */
export interface FakeHostProcess {
  id: string
  /** `running` unless a test wants a process the round finds already gone. */
  state?: 'running' | 'exited'
  exitCode?: number
  /** Called on every `status()` read, before it answers — where a test lands a suspend. */
  onStatus?: () => void | Promise<void>
}

/** A sandbox session holding the given processes; `kill` is a spy over every signal sent. */
export function createFakeSession(processes: FakeHostProcess[] = [{ id: HANDLE.processId }]) {
  const byId = new Map(processes.map(process => [process.id, process]))
  const kill = vi.fn(async (_id: string, _signal?: number) => {})

  const handleFor = (process: FakeHostProcess): SandboxProcessHandle => {
    const command = ['node'] as unknown as SandboxCommand
    return {
      id: process.id,
      pid: 1,
      command,
      status: async (): Promise<ProcessStatus> => {
        await process.onStatus?.()
        const base = { id: process.id, pid: 1, command, startedAt: new Date().toISOString() }
        return process.state === 'exited'
          ? { ...base, state: 'exited', exit: { code: process.exitCode ?? 0, timedOut: false }, endedAt: new Date().toISOString() }
          : { ...base, state: 'running' }
      },
      waitForExit: async () => ({ code: process.exitCode ?? 0, timedOut: false }),
      kill: async (signal?: number) => {
        await kill(process.id, signal)
      },
    } as unknown as SandboxProcessHandle
  }

  const session = {
    getProcess: async (id: string) => {
      const process = byId.get(id)
      return process ? handleFor(process) : null
    },
  } as unknown as SandboxSession

  return { session, kill }
}

/** A `finish` frame, completed unless a test says otherwise. */
export function finishFrame(options: { seq?: number, stopped?: 'completed' | 'interrupted' } = {}): Record<string, unknown> {
  return {
    type: 'finish',
    seq: options.seq ?? 3,
    finishReason: { unified: 'stop', raw: 'stop' },
    totalUsage: { inputTokens: {}, outputTokens: {} },
    stopped: options.stopped ?? 'completed',
  }
}

/**
 * A clock `offsetMs` past the handle's start that moves with `Date.now()` — which fake timers
 * drive too — so the round's settle windows and sample slices pass as the test advances them.
 */
export function runningClock(offsetMs: number): () => number {
  const startedAt = Date.now()
  return () => HANDLE.startedAtMs! + offsetMs + (Date.now() - startedAt)
}

/**
 * Only the members the round calls; `appended` collects every line it published. The cursor is
 * the last appended event's, as `LiveMirror.cursor` says, so a later round reads it as its floor.
 */
export function fakeMirror(appended: string[], cursor?: string): LiveMirror {
  let latest = cursor
  return {
    append: (bytes: Uint8Array, eventCursor: string) => {
      appended.push(new TextDecoder().decode(bytes))
      latest = eventCursor
    },
    noteGap: () => {},
    flush: async () => {},
    bytes: 0,
    get cursor() {
      return latest
    },
  }
}
