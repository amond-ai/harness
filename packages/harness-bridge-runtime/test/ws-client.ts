/**
 * The runtime under test, driven from outside its module graph.
 *
 * A real WebSocket server against a fake `onStart`, which is the whole point of the suite this
 * serves: every case here is a claim about the *transport* — the token gate, the `seq` counter,
 * the journal, the replay, the control commands — and none of them should need an agent to prove.
 * `harness-claude-code-bridge` already drives the same runtime through the Agent SDK; these
 * exercise it with nothing behind it at all.
 *
 * The socket half is a copy of `harness-claude-code-bridge/test/harness.ts`'s. Copied rather than
 * shared: making it shared would mean a second export on one of the two packages purely so the
 * other's tests could reach it, and a test helper is not a reason to widen a package surface.
 */
import type { Buffer } from 'node:buffer'
import type { BridgeHandle, BridgeTurn, RunBridgeOptions } from '../src/index'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { runBridge } from '../src/index'

/** A frame as it arrives on the wire. */
export type Frame = Record<string, unknown> & { type: string, seq?: number }

/** The `start` every case here sends; the runtime only requires the discriminant. */
export interface TestStart {
  type: 'start'
  prompt?: string
}

/**
 * A port nothing is listening on, obtained by binding one and letting go.
 *
 * Inherently racy — another process can claim it in the gap — but it is the only way to name a
 * port *before* the runtime binds it, which the token-guard case needs: its claim is that a
 * refused `runBridge` left no listener behind, and that is only provable by binding the same
 * port again afterwards.
 */
export async function freePort(): Promise<number> {
  const server = createServer()
  return new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address != null ? address.port : 0
      server.close(() => (port === 0 ? reject(new Error('no port assigned')) : resolve(port)))
    })
  })
}

export interface FakeTurn {
  /** Resolves with the `BridgeTurn` the runtime handed `onStart`, once a `start` has arrived. */
  readonly started: Promise<BridgeTurn>
  /** The `start` payload `onStart` was called with, or `undefined` before the first one. */
  readonly start: TestStart | undefined
  /** How many times `onStart` was invoked — one per turn the runtime accepted. */
  readonly callCount: number
  /** Interrupt reasons delivered to the handler registered via `turn.onInterrupt`. */
  readonly interrupts: string[]
  /** Let the pending `onStart` return, which is what moves the runtime back to `waiting`. */
  finish: () => void
  readonly onStart: RunBridgeOptions<TestStart>['onStart']
}

/**
 * An `onStart` that hands the test the turn and then waits.
 *
 * Pending by default, because `running` is the state most of these cases are about: a second
 * `start`, an `interrupt`, a `resume` mid-turn. `finish()` is what releases it.
 */
export function createFakeTurn(): FakeTurn {
  let resolveStarted: ((turn: BridgeTurn) => void) | undefined
  let release: (() => void) | undefined
  let start: TestStart | undefined
  let callCount = 0
  const interrupts: string[] = []
  const started = new Promise<BridgeTurn>((resolve) => {
    resolveStarted = resolve
  })

  return {
    started,
    get start() {
      return start
    },
    get callCount() {
      return callCount
    },
    interrupts,
    finish: () => release?.(),
    onStart: (received, turn) => {
      callCount++
      start = received
      turn.onInterrupt(reason => interrupts.push(reason))
      resolveStarted?.(turn)
      return new Promise<void>((resolve) => {
        release = resolve
      })
    },
  }
}

export interface Runtime {
  port: number
  token: string
  bridgeStateDir: string
  journalPath: string
  /** Sockets `connect` opened against this runtime; all torn down by `close()`. */
  sockets: WebSocket[]
  close: () => Promise<void>
  readJournal: () => Promise<Frame[]>
  /** Resolves when the runtime called `onExit` — the settle point of `stop` / `destroy`. */
  exited: Promise<void>
}

export async function startRuntime(input: {
  onStart: RunBridgeOptions<TestStart>['onStart']
  onStop?: RunBridgeOptions<TestStart>['onStop']
  onDestroy?: RunBridgeOptions<TestStart>['onDestroy']
  bridgeType?: string
}): Promise<Runtime> {
  const bridgeStateDir = await mkdtemp(join(tmpdir(), 'bridge-runtime-test-'))
  const token = `t-${Math.random().toString(36).slice(2)}`
  let markExited: (() => void) | undefined
  const exited = new Promise<void>((resolve) => {
    markExited = resolve
  })
  const handle: BridgeHandle = await runBridge<TestStart>({
    bridgeType: input.bridgeType ?? 'test',
    bridgeStateDir,
    port: 0,
    token,
    onStart: input.onStart,
    ...(input.onStop === undefined ? {} : { onStop: input.onStop }),
    ...(input.onDestroy === undefined ? {} : { onDestroy: input.onDestroy }),
    onExit: () => markExited?.(),
  })
  const journalPath = join(bridgeStateDir, 'event-log.ndjson')
  const sockets: WebSocket[] = []
  return {
    port: handle.port,
    token,
    bridgeStateDir,
    journalPath,
    sockets,
    exited,
    close: async () => {
      for (const socket of sockets) {
        socket.terminate()
      }
      await handle.close()
    },
    readJournal: async () => {
      const text = await readFile(journalPath, 'utf8').catch(() => '')
      return text
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Frame)
    },
  }
}

export interface Client {
  send: (message: Record<string, unknown>) => void
  frames: Frame[]
  /** Resolve once a frame matching `predicate` has arrived. */
  waitFor: (predicate: (frame: Frame) => boolean) => Promise<Frame>
  /** Resolve once this socket closed, with the code the peer sent. */
  closed: Promise<number>
  close: () => void
}

export async function connect(
  runtime: Runtime,
  options: { token?: string } = {},
): Promise<Client> {
  const token = options.token ?? runtime.token
  const socket = new WebSocket(
    `ws://127.0.0.1:${runtime.port}/?agent_bridge_token=${token}`,
  )
  const frames: Frame[] = []
  runtime.sockets.push(socket)
  const closed = new Promise<number>((resolve) => {
    socket.once('close', (code: number) => resolve(code))
  })
  const watchers: Array<{
    predicate: (frame: Frame) => boolean
    resolve: (frame: Frame) => void
  }> = []

  socket.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString('utf8')) as Frame
    frames.push(frame)
    for (const watcher of [...watchers]) {
      if (watcher.predicate(frame)) {
        watchers.splice(watchers.indexOf(watcher), 1)
        watcher.resolve(frame)
      }
    }
  })

  await new Promise<void>((resolve, reject) => {
    socket.once('open', () => resolve())
    socket.once('error', reject)
  })

  return {
    send: message => socket.send(JSON.stringify(message)),
    frames,
    closed,
    waitFor: predicate =>
      new Promise<Frame>((resolve, reject) => {
        const existing = frames.find(predicate)
        if (existing) {
          resolve(existing)
          return
        }
        let timer: ReturnType<typeof setTimeout> | undefined
        const watcher = {
          predicate,
          resolve: (frame: Frame) => {
            clearTimeout(timer)
            resolve(frame)
          },
        }
        timer = setTimeout(() => {
          // Drop the watcher with the rejection. Left in place it keeps its
          // predicate closure alive until some unrelated frame happens to match
          // and calls its already-settled `resolve`.
          const index = watchers.indexOf(watcher)
          if (index !== -1) {
            watchers.splice(index, 1)
          }
          reject(new Error('timed out waiting for a frame'))
        }, 5000)
        watchers.push(watcher)
      }),
    close: () => socket.close(),
  }
}
