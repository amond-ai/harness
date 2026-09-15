import type { Options, Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { Buffer } from 'node:buffer'
import type { QueryFn } from '../src/turn-driver'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBridge } from '@amond-ai/harness-bridge-runtime'
import { WebSocket } from 'ws'
import { createTurnDriver } from '../src/turn-driver'

/** A frame as it arrives on the wire. */
export type Frame = Record<string, unknown> & { type: string, seq?: number }

export interface FakeQuery {
  /** Push one more SDK message into the running turn. */
  push: (message: Record<string, unknown>) => void
  /** End the message stream. */
  end: () => void
  /** The `options` the driver called `query()` with. */
  readonly options: Options | undefined
  /** How many times `interrupt()` was called. */
  readonly interruptCount: number
  readonly called: boolean
  /** How many times `query()` was invoked — one per turn the driver started. */
  readonly callCount: number
  readonly fn: QueryFn
}

/**
 * A `query()` that yields whatever the test pushes and records what it was
 * called with. `interrupt()` ends the script the way the real SDK does — with
 * a `result` carrying `terminal_reason: 'aborted_streaming'`.
 */
export interface FakeQueryOptions {
  /**
   * What `interrupt()` answers with, the way the real SDK does — by default the
   * `aborted_streaming` success result. A record is merged into that one, so a test can make
   * the wind-down land on an error-shaped `result` instead; `false` models the query that never
   * answers at all, which is the case the host's escalation timer exists for.
   */
  resultOnInterrupt?: false | Record<string, unknown>
}

export function createFakeQuery(
  script: Array<Record<string, unknown>> = [],
  behaviour: FakeQueryOptions = {},
): FakeQuery {
  const queued: Array<Record<string, unknown>> = [...script]
  let waiter: ((result: IteratorResult<SDKMessage>) => void) | undefined
  let ended = false
  let options: Options | undefined
  let interruptCount = 0
  let callCount = 0

  const push = (message: Record<string, unknown>): void => {
    if (waiter) {
      const resolve = waiter
      waiter = undefined
      resolve({ value: message as unknown as SDKMessage, done: false })
      return
    }
    queued.push(message)
  }

  const end = (): void => {
    ended = true
    if (waiter) {
      const resolve = waiter
      waiter = undefined
      resolve({ value: undefined, done: true })
    }
  }

  const fn: QueryFn = (params) => {
    callCount++
    options = params.options
    const iterator: AsyncIterator<SDKMessage> = {
      next: () => {
        const next = queued.shift()
        if (next !== undefined) {
          return Promise.resolve({
            value: next as unknown as SDKMessage,
            done: false,
          })
        }
        if (ended) {
          return Promise.resolve({ value: undefined, done: true })
        }
        return new Promise<IteratorResult<SDKMessage>>((resolve) => {
          waiter = resolve
        })
      },
    }
    const query = {
      [Symbol.asyncIterator]: () => iterator,
      next: () => iterator.next(),
      interrupt: () => {
        interruptCount++
        if (behaviour.resultOnInterrupt !== false) {
          push(resultMessage({ terminal_reason: 'aborted_streaming', ...behaviour.resultOnInterrupt }))
        }
        return Promise.resolve(undefined)
      },
    }
    return query as unknown as Query
  }

  return {
    push,
    end,
    fn,
    get options() {
      return options
    },
    get interruptCount() {
      return interruptCount
    },
    get called() {
      return callCount > 0
    },
    get callCount() {
      return callCount
    },
  }
}

export function initMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    session_id: 'sess-1',
    cwd: '/workspace/repo',
    slash_commands: ['software-factory:implement'],
    ...overrides,
  }
}

export function resultMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'result',
    subtype: 'success',
    result: 'done',
    session_id: 'sess-1',
    usage: { input_tokens: 1, output_tokens: 2 },
    total_cost_usd: 0.01,
    ...overrides,
  }
}

/** A `stream_event` carrying one text delta, plus its block start/stop. */
export function streamEventMessages(): Array<Record<string, unknown>> {
  return [
    {
      type: 'stream_event',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    },
    {
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
    },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
  ]
}

export interface Host {
  port: number
  token: string
  bridgeStateDir: string
  journalPath: string
  /** Sockets `connect` opened against this host; all closed by `close()`. */
  sockets: WebSocket[]
  close: () => Promise<void>
  readJournal: () => Promise<Frame[]>
}

export async function startHost(input: {
  query: QueryFn
  exit?: (code: number) => void
}): Promise<Host> {
  const bridgeStateDir = await mkdtemp(join(tmpdir(), 'turn-host-test-'))
  const token = `t-${Math.random().toString(36).slice(2)}`
  const handle = await runBridge({
    bridgeType: 'claude-code',
    bridgeStateDir,
    port: 0,
    token,
    onStart: createTurnDriver({
      query: input.query,
      workdir: '/workspace/repo',
      exit: input.exit ?? (() => {}),
    }),
    onExit: () => {},
  })
  const journalPath = join(bridgeStateDir, 'event-log.ndjson')
  const sockets: WebSocket[] = []
  return {
    port: handle.port,
    token,
    bridgeStateDir,
    journalPath,
    sockets,
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
  /**
   * Resolve once the host closed this socket. The host does that only after
   * `flushPendingEventsToDisk`, so it is the point at which every queued frame
   * has been sent — the settle point a delivery-count assertion needs.
   */
  closed: Promise<void>
  close: () => void
}

/**
 * `onFrame` runs synchronously as each frame arrives, before the frame is
 * recorded — the only place a test can observe what was true at delivery time
 * (e.g. what the journal held when the socket saw the frame).
 */
export async function connect(
  host: Host,
  onFrame?: (frame: Frame) => void,
): Promise<Client> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${host.port}/?agent_bridge_token=${host.token}`,
  )
  const frames: Frame[] = []
  host.sockets.push(socket)
  const closed = new Promise<void>((resolve) => {
    socket.once('close', () => resolve())
  })
  const watchers: Array<{
    predicate: (frame: Frame) => boolean
    resolve: (frame: Frame) => void
  }> = []

  socket.on('message', (raw: Buffer) => {
    const frame = JSON.parse(raw.toString('utf8')) as Frame
    onFrame?.(frame)
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
        const timer = setTimeout(
          () => reject(new Error('timed out waiting for a frame')),
          5000,
        )
        watchers.push({
          predicate,
          resolve: (frame) => {
            clearTimeout(timer)
            resolve(frame)
          },
        })
      }),
    close: () => socket.close(),
  }
}
