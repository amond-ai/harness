import type { Buffer } from 'node:buffer'
import type { CodexEvent } from '../src/create-emit-stream-event'
import type { CodexFactory, CodexLike, CodexThreadLike } from '../src/turn-driver'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runBridge } from '@amond-ai/harness-bridge-runtime'
import { WebSocket } from 'ws'
import { createTurnDriver } from '../src/turn-driver'

/** A frame as it arrives on the wire. */
export type Frame = Record<string, unknown> & { type: string, seq?: number }

export interface FakeThreadRun {
  input: string
  turnOptions: { signal?: AbortSignal, outputSchema?: unknown } | undefined
}

export interface FakeCodex {
  /** Push one more Codex event into the running turn. */
  push: (event: CodexEvent) => void
  /** End the event stream. */
  end: () => void
  /** The options the driver constructed `Codex` with. */
  readonly constructedWith: Record<string, unknown> | undefined
  /** The options the driver opened the thread with. */
  readonly threadOptions: Record<string, unknown> | undefined
  /** The thread id `resumeThread` was called with, if it was. */
  readonly resumedId: string | undefined
  /** How many fresh threads the driver started. */
  readonly startThreadCount: number
  /** Every `runStreamed` call, in order. */
  readonly runs: FakeThreadRun[]
  readonly called: boolean
  readonly factory: CodexFactory
}

export interface FakeCodexOptions {
  /**
   * How the stream reacts to the `signal` the driver passed it. The real SDK
   * kills the CLI child, so its generator rejects — that is the default, and it
   * is the path the driver's "an abort is never the SDK's own failure" branch
   * exists for. `'end'` models the gentler generator that simply returns.
   */
  onAbort?: 'throw' | 'end'
}

/**
 * A `Codex` that yields whatever the test pushes and records what it was
 * constructed and run with.
 *
 * One event queue across every thread and every turn, like the Claude suite's
 * fake `query()`: a test scripts the next turn by pushing before the `start`
 * that consumes it.
 */
/** The events after which `codex exec` has nothing more to say about a turn. */
const TERMINAL_EVENT_TYPES = new Set(['turn.completed', 'turn.failed', 'error'])

export function createFakeCodex(
  script: CodexEvent[] = [],
  behaviour: FakeCodexOptions = {},
): FakeCodex {
  const queued: CodexEvent[] = [...script]
  /** Woken by `push`/`end`; the stream parks here when the queue runs dry. */
  let notify: (() => void) | undefined
  let ended = false
  let constructedWith: Record<string, unknown> | undefined
  let threadOptions: Record<string, unknown> | undefined
  let resumedId: string | undefined
  let startThreadCount = 0
  const runs: FakeThreadRun[] = []

  const wake = (): void => {
    const waiter = notify
    notify = undefined
    waiter?.()
  }

  const push = (event: CodexEvent): void => {
    queued.push(event)
    wake()
  }

  /**
   * End the shared event stream for good — the CLI exiting without a terminal
   * event. A turn whose terminal event arrived ends on its own.
   */
  const end = (): void => {
    ended = true
    wake()
  }

  const thread: CodexThreadLike = {
    runStreamed: (input, turnOptions) => {
      runs.push({ input, turnOptions })
      const signal = turnOptions?.signal
      /*
       * One `runStreamed` is one turn, and the real stream is the CLI child's
       * stdout: it ends when the turn does. So a terminal event closes *this*
       * run's stream while leaving the shared queue for the next one, which is
       * what lets a test script several turns up front.
       */
      let finished = false
      const next = async (): Promise<IteratorResult<CodexEvent>> => {
        while (true) {
          if (signal?.aborted) {
            if (behaviour.onAbort === 'end') {
              return { value: undefined, done: true }
            }
            throw abortError()
          }
          if (finished) {
            return { value: undefined, done: true }
          }
          const event = queued.shift()
          if (event !== undefined) {
            if (TERMINAL_EVENT_TYPES.has(event.type)) {
              finished = true
            }
            return { value: event, done: false }
          }
          if (ended) {
            return { value: undefined, done: true }
          }
          await new Promise<void>((resolve, reject) => {
            notify = resolve
            signal?.addEventListener(
              'abort',
              () => {
                if (behaviour.onAbort === 'end') {
                  resolve()
                  return
                }
                reject(abortError())
              },
              { once: true },
            )
          })
        }
      }
      const events: AsyncIterable<CodexEvent> = {
        [Symbol.asyncIterator]: () => ({ next }),
      }
      return Promise.resolve({ events })
    },
  }

  const codex: CodexLike = {
    startThread: (options) => {
      startThreadCount++
      threadOptions = options
      return thread
    },
    resumeThread: (id, options) => {
      resumedId = id
      threadOptions = options
      return thread
    },
  }

  return {
    push,
    end,
    factory: (options) => {
      constructedWith = options
      return codex
    },
    get constructedWith() {
      return constructedWith
    },
    get threadOptions() {
      return threadOptions
    },
    get resumedId() {
      return resumedId
    },
    get startThreadCount() {
      return startThreadCount
    },
    get runs() {
      return runs
    },
    get called() {
      return runs.length > 0
    },
  }
}

function abortError(): Error {
  const error = new Error('The operation was aborted')
  error.name = 'AbortError'
  return error
}

export function threadStarted(threadId = 'thr-1'): CodexEvent {
  return { type: 'thread.started', thread_id: threadId }
}

/** The three events one agent message arrives as. */
export function agentMessageEvents(
  text: string,
  id = 'item-msg-1',
): CodexEvent[] {
  return [
    { type: 'item.started', item: { id, type: 'agent_message', text: '' } },
    { type: 'item.updated', item: { id, type: 'agent_message', text } },
    { type: 'item.completed', item: { id, type: 'agent_message', text } },
  ]
}

/** The two events one shell command arrives as. */
export function commandExecutionEvents(
  command = 'ls',
  id = 'item-cmd-1',
): CodexEvent[] {
  return [
    {
      type: 'item.started',
      item: { id, type: 'command_execution', command, status: 'in_progress' },
    },
    {
      type: 'item.completed',
      item: {
        id,
        type: 'command_execution',
        command,
        aggregated_output: 'README.md\n',
        exit_code: 0,
        status: 'completed',
      },
    },
  ]
}

export function turnCompleted(
  usage: Record<string, number> = {
    input_tokens: 10,
    cached_input_tokens: 4,
    cache_write_input_tokens: 3,
    output_tokens: 7,
    reasoning_output_tokens: 5,
  },
): CodexEvent {
  return { type: 'turn.completed', usage }
}

/** A whole successful turn: thread, one message, completion. */
export function successfulTurn(): CodexEvent[] {
  return [
    threadStarted(),
    ...agentMessageEvents('hi'),
    turnCompleted(),
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
  codex: CodexFactory
  workdir?: string
}): Promise<Host> {
  const bridgeStateDir = await mkdtemp(join(tmpdir(), 'codex-host-test-'))
  const token = `t-${Math.random().toString(36).slice(2)}`
  const driver = createTurnDriver({
    createCodex: input.codex,
    workdir: input.workdir ?? '/workspace/repo',
  })
  const handle = await runBridge({
    bridgeType: 'codex',
    bridgeStateDir,
    port: 0,
    token,
    onStart: driver.onStart,
    onStop: driver.onStop,
    onDestroy: driver.onDestroy,
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
  close: () => void
}

export async function connect(host: Host): Promise<Client> {
  const socket = new WebSocket(
    `ws://127.0.0.1:${host.port}/?agent_bridge_token=${host.token}`,
  )
  const frames: Frame[] = []
  host.sockets.push(socket)
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
