// Shared in-sandbox bridge runtime. Adapter `bridge.mjs` bundles re-bundle
// this module (tsup inlines it; `ws` stays external and resolves from the
// sandbox-installed node_modules). It owns everything generic to the bridge
// transport — the WebSocket server, token auth, the in-memory event log +
// monotonic `seq`, resume replay, and the lifecycle/meta files. Any number of
// hosts may be connected; exactly one of them owns the event stream, and
// `start`/`resume` transfer that ownership. The adapter supplies only `onStart`
// (drive its CLI/SDK and translate to wire events) and lifecycle cleanup hooks.

import type { WebSocket } from 'ws'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import process, { pid, env as procEnv, stdout } from 'node:process'
import { StringDecoder } from 'node:string_decoder'
import { WebSocketServer } from 'ws'

export { HarnessBridgeCapabilityUnsupportedError } from './harness-bridge-capability-unsupported-error'

export type BridgeState = 'init' | 'waiting' | 'running' | 'draining' | 'done'

/** Outbound turn event the adapter emits. `seq` is added by the runtime. */
export type BridgeEvent = Record<string, unknown> & { type: string }

export type BridgeDebugLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace'

export interface Experimental_BridgeUserMessage {
  readonly messageId: string
  readonly text: string
  accept: () => void
  reject: (error: unknown) => void
}

export interface Experimental_BridgeUserMessageQueue extends AsyncIterable<Experimental_BridgeUserMessage> {
  readonly pendingCount: number
  close: (error?: unknown) => void
}

type InternalBridgeUserMessageQueue = Experimental_BridgeUserMessageQueue & {
  enqueue: (input: { messageId: string, text: string }) => void
}

// A type alias, not an interface: it is emitted through `emit`, whose
// `BridgeEvent` is a `Record<string, unknown>`, and only an alias carries the
// implicit index signature that assignment needs.
// eslint-disable-next-line ts/consistent-type-definitions
type BridgeUserMessageResponse = {
  type: 'user-message-response'
  messageId: string
  accepted: boolean
  error?: { message: string }
}

/**
 * Per-session diagnostics config. The host resolves it from settings +
 * env and sends it on `start.debug`; the bridge gates console capture and
 * structured `debug-event`s on it. When disabled, nothing is captured or
 * emitted and no `seq` is consumed.
 */
export interface BridgeDebugConfig {
  enabled?: boolean
  level?: BridgeDebugLevel
  subsystems?: string[]
}

const DEBUG_LEVEL_WEIGHT: Record<BridgeDebugLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
}

/** Exact-or-dotted-prefix subsystem match (`'bridge'` matches `'bridge.turn'`). */
function subsystemMatches(
  filters: string[] | undefined,
  subsystem: string,
): boolean {
  if (!filters || filters.length === 0) {
    return true
  }
  return filters.some(
    filter => subsystem === filter || subsystem.startsWith(`${filter}.`),
  )
}

function formatBridgeError(err: unknown): {
  name?: string
  message: string
  stack?: string
} {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  if (typeof err === 'string') {
    return { message: err }
  }
  if (err !== null && typeof err === 'object') {
    try {
      return { message: JSON.stringify(err) }
    }
    catch {}
  }
  return { message: String(err) }
}

function createBridgeUserMessageQueue(options: {
  respond: (response: BridgeUserMessageResponse) => void
}): InternalBridgeUserMessageQueue {
  const messages: Experimental_BridgeUserMessage[] = []
  const waiters: Array<
    (result: IteratorResult<Experimental_BridgeUserMessage>) => void
  > = []
  const entries = new Map<
    string,
    {
      response?: BridgeUserMessageResponse
      reject: (error: unknown) => void
    }
  >()
  let closed = false
  let pendingCount = 0

  const enqueue = (input: { messageId: string, text: string }): void => {
    const existing = entries.get(input.messageId)
    if (existing != null) {
      if (existing.response != null) {
        options.respond(existing.response)
      }
      return
    }

    let settled = false
    const settle = (response: BridgeUserMessageResponse): void => {
      if (settled) {
        return
      }
      settled = true
      pendingCount--
      const entry = entries.get(input.messageId)
      if (entry != null) {
        entry.response = response
      }
      options.respond(response)
    }
    const message: Experimental_BridgeUserMessage = {
      messageId: input.messageId,
      text: input.text,
      accept: () => {
        settle({
          type: 'user-message-response',
          messageId: input.messageId,
          accepted: true,
        })
      },
      reject: (error) => {
        settle({
          type: 'user-message-response',
          messageId: input.messageId,
          accepted: false,
          error: { message: formatBridgeError(error).message },
        })
      },
    }
    entries.set(input.messageId, {
      reject: message.reject,
    })
    pendingCount++

    if (closed) {
      message.reject(
        new Error('The bridge turn is no longer accepting user messages.'),
      )
      return
    }

    const waiter = waiters.shift()
    if (waiter != null) {
      waiter({ done: false, value: message })
    }
    else {
      messages.push(message)
    }
  }

  const close = (error?: unknown): void => {
    if (closed) {
      return
    }
    closed = true
    const reason
      = error
        ?? new Error('The bridge turn ended before accepting the user message.')
    for (const entry of entries.values()) {
      if (entry.response == null) {
        entry.reject(reason)
      }
    }
    messages.length = 0
    while (waiters.length > 0) {
      waiters.shift()!({ done: true, value: undefined })
    }
  }

  return {
    get pendingCount() {
      return pendingCount
    },
    enqueue,
    close,
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          const message = messages.shift()
          if (message != null) {
            return Promise.resolve({ done: false as const, value: message })
          }
          if (closed) {
            return Promise.resolve({
              done: true as const,
              value: undefined,
            })
          }
          return new Promise<IteratorResult<Experimental_BridgeUserMessage>>(
            (resolve) => {
              waiters.push(resolve)
            },
          )
        },
      }
    },
  }
}

function parseEnvList(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined
  }
  const items = value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

const ENV_TRUTHY = new Set(['1', 'true', 'yes', 'on'])

/**
 * Where in the turn's life an `error` frame came from. `start` is a `start`
 * frame the host refused; `init` is a check that failed on `system`/`init`
 * before a token was spent; `run` is everything after.
 */
export type BridgeErrorPhase = 'start' | 'init' | 'run'

/** Why the Worker is stopping the turn. Carried on the `interrupt` command. */
export type InterruptReason = 'watchdog' | 'budget' | 'operator'

/** Per-frame emission options. */
export interface BridgeEmitOptions {
  /**
   * Journal the frame to `event-log.ndjson` and keep it in the replay log.
   * Defaults to `true`; `false` makes the frame live-only.
   */
  journal?: boolean
}

/**
 * Per-turn surface handed to {@link RunBridgeOptions.onStart}. The adapter
 * drives its runtime against these primitives; the runtime owns the transport.
 */
export interface BridgeTurn {
  /**
   * Emit a turn event to the host. Stamps a monotonic `seq`, appends to the
   * replay log and the disk journal, and sends to the live socket
   * (best-effort — if the host is mid-reconnect the event waits in the log and
   * is replayed on resume). The disk append is awaited before the send, so a
   * frame the host has seen is always already journaled.
   *
   * `{ journal: false }` makes the frame live-only: it still takes a `seq` and
   * still goes out in order, but it is neither journaled nor replayed. Used
   * for the token deltas, which are liveness, not transcript.
   */
  emit: (event: BridgeEvent, options?: BridgeEmitOptions) => void

  /**
   * Register interest in a host-executed tool result and resolve when the
   * matching `tool-result` arrives. The adapter emits the `tool-call` event
   * itself (via {@link emit}) using the same `toolCallId`.
   */
  requestToolResult: (
    toolCallId: string,
  ) => Promise<{ output: unknown, isError?: boolean }>

  /**
   * Register interest in a host approval decision and resolve when the matching
   * `tool-approval-response` arrives. The adapter emits the
   * `tool-approval-request` event itself using the same `approvalId`.
   */
  requestToolApproval: (
    approvalId: string,
  ) => Promise<{ approved: boolean, reason?: string }>

  readonly experimental_userMessages: Experimental_BridgeUserMessageQueue

  /** Aborts when the host sends `abort`. */
  readonly abortSignal: AbortSignal

  /**
   * Register the turn's handler for an inbound `interrupt`. Unlike `abort`,
   * which tears the runtime down, an interrupt asks the agent to stop and
   * still produce a `result` — so only the adapter knows how to do it. An
   * `interrupt` that arrives with no handler registered is answered with a
   * control-frame error on the sending socket.
   */
  onInterrupt: (handler: (reason: InterruptReason) => void) => void

  /**
   * Settle every queued journal append and socket send. Await it before
   * exiting the process on a path that must not lose its last frame.
   */
  flush: () => Promise<void>

  /** True for the first turn since this bridge process started. */
  readonly firstTurn: boolean

  /**
   * Emit a structured diagnostic. Gated by the session's debug level +
   * subsystem filter; a no-op when diagnostics are disabled. Adapters use this
   * for runtime-level instrumentation; raw `console.*` output is captured and
   * forwarded automatically.
   */
  bridgeLog: (input: {
    level?: BridgeDebugLevel
    subsystem: string
    message: string
    attrs?: Record<string, unknown>
    error?: unknown
  }) => void

  /**
   * Emit a non-fatal bridge warning to stderr using the runtime's harness
   * prefix. This is diagnostic-only: it does not emit a stream event, does not
   * consume a `seq`, and does not fail the turn.
   */
  emitWarning: (input: { message: string }) => void

  emitError: (input: {
    error: unknown
    message?: string
    phase?: BridgeErrorPhase
    /**
     * Where this turn's two durable files stand, when the caller knows.
     *
     * On an `error` as well as on `finish`, because a run-phase failure is the
     * ordinary way a turn ends badly and the client that retries it needs the
     * session it should resume. Passed through verbatim; the bridge does not
     * inspect or build it.
     */
    sessionArtifacts?: Record<string, unknown>
  }) => void

  /** Absolute path of this turn's journal, reported in `finish`. */
  readonly journalPath: string
}

export interface RunBridgeOptions<TStart extends { type: 'start' }> {
  /** Identifier written into `bridge-meta.json` (`'claude-code'` / `'codex'`). */
  bridgeType: string
  /** Directory for `bridge-meta.json` / `start-config.json`. Created if absent. */
  bridgeStateDir: string
  /** Drive one prompt turn. Rejections surface to the host as an `error` event. */
  onStart: (start: TStart, turn: BridgeTurn) => Promise<void>
  /**
   * Produce the adapter-defined runtime resume data for `stop`. Defaults to
   * `{}`.
   */
  onStop?: () => unknown | Promise<unknown>
  /**
   * Perform adapter-defined destruction before the bridge exits.
   */
  onDestroy?: () => void | Promise<void>
  /** WS port. Defaults to `BRIDGE_WS_PORT` env (0 = OS-assigned). */
  port?: number
  /** Auth token. Defaults to `BRIDGE_CHANNEL_TOKEN` env. */
  token?: string
  /** Called with the bound port once the server is listening. */
  onListening?: (port: number) => void
  /**
   * Tear the process down after `stop` / `destroy`. Defaults to closing
   * the server and calling `process.exit(0)`. Overridable for tests.
   */
  onExit?: () => void
}

type InboundControl
  = | {
    type: 'tool-result'
    toolCallId: string
    output: unknown
    isError?: boolean
  }
  | {
    type: 'tool-approval-response'
    approvalId: string
    approved: boolean
    reason?: string
  }
  | { type: 'user-message', messageId?: string, text: string }
  | { type: 'abort' }
  | { type: 'interrupt', reason: InterruptReason }
  | { type: 'stop' }
  | { type: 'destroy' }
  | { type: 'resume', lastSeenEventId: number }

const WS_OPEN = 1

/**
 * Boot the bridge: bind the WebSocket server, announce `bridge-ready`, and
 * service host connections for the lifetime of the process. Resolves once the
 * server is listening; the process then stays alive on the server until a
 * `stop` / `destroy` exits it.
 */
export interface BridgeHandle {
  /** The port the WebSocket server bound to. */
  readonly port: number
  /** Close the WebSocket server. Does not call `process.exit`. */
  close: () => Promise<void>
}

export async function runBridge<TStart extends { type: 'start' }>(
  options: RunBridgeOptions<TStart>,
): Promise<BridgeHandle> {
  const { bridgeType, bridgeStateDir, onStart, onStop, onDestroy } = options
  const expectedToken = options.token ?? procEnv.BRIDGE_CHANNEL_TOKEN ?? ''
  /*
   * Fail closed. The server binds `0.0.0.0`, and the token is the only thing
   * standing between that port and a turn: with none configured the check
   * compared `''` to `''` and authorized any client that sent an empty
   * `agent_bridge_token`. Refused before the listener exists, so an
   * unconfigured host has no open port rather than an open one.
   */
  if (expectedToken === '') {
    throw new Error(
      'bridge channel token is required: pass `token` or set BRIDGE_CHANNEL_TOKEN',
    )
  }
  const bridgeWsPort
    = options.port ?? Number.parseInt(procEnv.BRIDGE_WS_PORT ?? '0', 10)

  const bridgeMetaPath = `${bridgeStateDir}/bridge-meta.json`
  const startConfigPath = `${bridgeStateDir}/start-config.json`
  const rerunStartConfigPath = `${bridgeStateDir}/rerun-start-config.json`
  const eventLogPath = `${bridgeStateDir}/event-log.ndjson`

  try {
    await mkdir(bridgeStateDir, { recursive: true })
  }
  catch {
    // Best-effort; the bridge still runs without its state files.
  }

  // ─── mutable runtime state ──────────────────────────────────────────
  let currentBoundPort = 0
  let currentTurnState: BridgeState = 'init'
  /*
   * The one connection turn events stream to. A socket claims it by asking for
   * work — `start` (a turn) or `resume` (a catch-up) — never by connecting:
   * every event goes here alone, so claiming on connect would silence a turn
   * already streaming to someone else. Any number of sockets may be connected;
   * the others still exchange control frames, they just get no events.
   */
  let activeSocket: WebSocket | undefined
  let isFirstTurn = true
  let turnAbort: AbortController | undefined
  let currentUserMessages: InternalBridgeUserMessageQueue | undefined
  // The running turn's `interrupt` handler, registered by the adapter through
  // `turn.onInterrupt`. Cleared when the turn settles, so a late `interrupt`
  // is answered rather than silently dropped.
  let currentInterrupt: ((reason: InterruptReason) => void) | undefined

  // Diagnostics. Resolved per turn from `start.debug` with a sandbox-side
  // env fallback; gates console capture + structured `debug-event`s.
  let debugConfig: BridgeDebugConfig | undefined
  let consoleCaptureInstalled = false
  const envDebugEnabled = ENV_TRUTHY.has(
    (procEnv.HARNESS_DEBUG ?? '').toLowerCase(),
  )

  // Replay log. `seq` is monotonic across the whole process — never reset —
  // because the host's cursor (`lastSeenEventId`) lives across turns. The log
  // *contents* are cleared at the start of each turn to bound memory; the
  // just-finished turn stays replayable until the next `start`. `resume` is
  // served from THIS log, not from disk — the disk file is the crash-recovery
  // copy — so the only bound on it is the length of one turn.
  let seqCounter = 0
  let eventLog: Array<{ seq: number, line: string }> = []

  /*
   * Disk journal. `<bridgeStateDir>/event-log.ndjson` is the turn's transcript,
   * and the Worker's `turn_end` mirror reads it, so a frame must be on disk
   * BEFORE it reaches the socket: otherwise the Worker can see an event that a
   * crash a moment later erases. Upstream appends to a buffer and schedules an
   * unawaited `setImmediate` flush, which does not give that.
   *
   * Every frame goes through one serial promise chain, so the awaited append
   * cannot reorder the stream: a frame is written, then sent, then the next
   * frame is considered. Live-only frames (the token deltas — see
   * `emit(event, { journal: false })`) ride the same chain so they keep their
   * place in the order; they simply skip the append.
   */
  let journalChain: Promise<void> = Promise.resolve()

  /*
   * Highest `seq` already delivered to `activeSocket`. Awaiting the append
   * before the send opens a window the upstream (synchronous) send did not
   * have: a `resume` can arrive while frames sit on the chain, and both the
   * chain and the replay would then reach for the same frame. The chain's send
   * step skips anything at or below this mark, and `replay` claims the frames
   * it is going to deliver by raising the mark before it yields. It is reset
   * whenever the active socket changes, so a fresh socket is never charged for
   * frames it did not receive.
   */
  let deliveredSeq = 0

  const enqueueFrame = (seq: number, line: string, journal: boolean): void => {
    journalChain = journalChain
      .then(async () => {
        if (journal) {
          await appendFile(eventLogPath, `${line}\n`).catch(() => {
            // Best-effort: a journal the filesystem refused must not stop the
            // turn, and the in-memory log still serves `resume`.
          })
        }
      })
      .then(() => {
        if (seq <= deliveredSeq) {
          return // already sent to this socket by `replay`
        }
        if (activeSocket?.readyState === WS_OPEN) {
          try {
            activeSocket.send(line)
            deliveredSeq = seq
          }
          catch {
            // Send is best-effort: a dropped socket leaves the event in the
            // log, replayed once the host reconnects and sends `resume`.
          }
        }
      })
  }

  /** Settle every queued append + send. Used before a clean stop/destroy. */
  const flushPendingEventsToDisk = async (): Promise<void> => {
    let settled = journalChain
    // Re-read the chain after each await: a frame emitted while we waited
    // extended it.
    for (;;) {
      await settled
      if (settled === journalChain) {
        return
      }
      settled = journalChain
    }
  }

  /*
   * When respawned for `replay`, reload the previous turn's log from disk before
   * accepting any connection so the very first `resume{lastSeenEventId}` can be
   * served the tail (including the terminal `finish`). The seq counter is
   * restored to the last persisted seq so it stays aligned with the host's
   * long-lived cursor. The file is NOT truncated in this mode — only a fresh
   * `start` (next turn) clears it.
   */
  const replayFromDisk = procEnv.BRIDGE_REPLAY_FROM_DISK === '1'
  if (replayFromDisk && existsSync(eventLogPath)) {
    try {
      const lines = readFileSync(eventLogPath, 'utf8')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
      eventLog = lines.map(line => ({
        seq: (JSON.parse(line) as { seq: number }).seq,
        line,
      }))
      seqCounter = eventLog.at(-1)?.seq ?? 0
    }
    catch {
      // Corrupt/partial log: fall back to an empty log; the host then degrades
      // to `rerun` instead of replaying a malformed tail.
      eventLog = []
      seqCounter = 0
    }
  }

  const pendingToolResults = new Map<
    string,
    (output: { output: unknown, isError?: boolean }) => void
  >()
  const pendingToolApprovals = new Map<
    string,
    (response: { approved: boolean, reason?: string }) => void
  >()

  // ─── persistence (best-effort meta + start config) ──────────────────
  const writeBridgeMeta = async (state: BridgeState): Promise<void> => {
    try {
      await writeFile(
        bridgeMetaPath,
        JSON.stringify({
          type: bridgeType,
          port: currentBoundPort,
          state,
          pid,
        }),
      )
    }
    catch {
      // Best-effort resilience metadata; not load-bearing for the active turn.
    }
  }

  const writeStartConfig = async (start: unknown): Promise<void> => {
    try {
      const serialized = JSON.stringify(start)
      await writeFile(startConfigPath, serialized)
      // Frozen copy: written once, restored over start-config.json by future
      // rerun-mode recovery to re-run the original turn from scratch.
      if (!existsSync(rerunStartConfigPath)) {
        await writeFile(rerunStartConfigPath, serialized)
      }
    }
    catch {
      // Best-effort.
    }
  }

  // ─── wire send + replay ─────────────────────────────────────────────
  const emit = (event: BridgeEvent, options?: BridgeEmitOptions): void => {
    const seq = ++seqCounter
    const line = JSON.stringify({ ...event, seq })
    const journal = options?.journal !== false
    if (journal) {
      eventLog.push({ seq, line })
    }
    enqueueFrame(seq, line, journal)
  }

  /*
   * Serve a reconnecting host the tail it has not seen. Ordering, and why it is
   * this ordering:
   *
   * The replay goes on the journal chain, behind every append already queued,
   * so a frame cannot reach the socket before it is on disk — the invariant
   * `emit` states, which a synchronous replay reading the in-memory log broke.
   * Sitting on the chain means frames queued ahead of it would otherwise
   * live-send to the newly claimed socket first, delivering the newest frames
   * before the older replayed ones. So the replay *claims* everything up to
   * `upTo` synchronously by raising `deliveredSeq`: those frames' own send
   * steps then skip, and the replay — which runs after their appends — delivers
   * them itself, in `seq` order and each exactly once. Frames emitted after
   * this point sit behind the replay in the chain and carry a higher `seq`, so
   * they follow the tail without a gap.
   *
   * The one thing this drops is a live-only frame (`{ journal: false }` — the
   * token deltas) queued at the moment of the resume: it is not in `eventLog`,
   * so nothing replays it. That matches what a resume already means for those
   * frames, which are liveness, not transcript, and are never replayed.
   */
  const replay = (ws: WebSocket, afterSeq: number): void => {
    const upTo = seqCounter
    // The host has seen everything up to its cursor, so the mark starts there
    // even when the log holds nothing newer to send.
    deliveredSeq = Math.max(afterSeq, upTo)
    journalChain = journalChain.then(() => {
      for (const entry of eventLog) {
        if (entry.seq > afterSeq && entry.seq <= upTo && ws.readyState === WS_OPEN) {
          ws.send(entry.line)
        }
      }
    })
  }

  // ─── diagnostics ──────────────────────────────────────────────
  const shouldEmitDebugEvent = (
    level: BridgeDebugLevel,
    subsystem: string,
  ): boolean => {
    if (!debugConfig?.enabled) {
      return false
    }
    const threshold = debugConfig.level ?? 'debug'
    if (DEBUG_LEVEL_WEIGHT[level] > DEBUG_LEVEL_WEIGHT[threshold]) {
      return false
    }
    return subsystemMatches(debugConfig.subsystems, subsystem)
  }

  /*
   * Forward sandbox console output. We line-buffer the original writers (kept so
   * output still reaches the real fds) and emit one `sandbox-log` per complete
   * line. `emit` never writes to stdout/stderr, so there is no recursion.
   * Installed lazily the first time a turn enables diagnostics; once installed,
   * capture is gated per-write on `debugConfig.enabled` so a later turn can
   * disable it. Console capture is independent of the subsystem/level filter.
   */
  const rawStderrWrite = process.stderr.write.bind(process.stderr)

  const writeErrorToStderr = (input: {
    message: string
    error: unknown
  }): void => {
    try {
      const formatted = formatBridgeError(input.error)
      rawStderrWrite(
        `[harness:${bridgeType}:error] ${input.message}: ${formatted.message}\n`,
      )
      if (formatted.stack) {
        rawStderrWrite(`${formatted.stack}\n`)
      }
    }
    catch {}
  }

  const emitWarning = (input: { message: string }): void => {
    try {
      for (const line of input.message.split('\n')) {
        if (line.trim().length > 0) {
          rawStderrWrite(`[harness:${bridgeType}:warn] ${line}\n`)
        }
      }
    }
    catch {}
  }

  const emitError = (input: {
    error: unknown
    message?: string
    phase?: BridgeErrorPhase
    sessionArtifacts?: Record<string, unknown>
  }): void => {
    writeErrorToStderr({
      message: input.message ?? 'bridge error',
      error: input.error,
    })
    emit({
      type: 'error',
      phase: input.phase ?? 'run',
      error: serialiseError(input.error),
      // Omitted rather than sent as `undefined` when the caller knows none:
      // an `error` from before the session exists says nothing about it.
      ...(input.sessionArtifacts === undefined
        ? {}
        : { sessionArtifacts: input.sessionArtifacts }),
    })
  }

  /*
   * Set by `installConsoleCapture`, read by `close`. The writers are captured
   * when the capture is installed, not when the bridge was created: a patch
   * another tool applied in between (a test runner's output capture) is then
   * forwarded to and restored, instead of being skipped over and then wiped.
   */
  let restoreConsoleWriters: (() => void) | undefined

  const installConsoleCapture = (): void => {
    if (consoleCaptureInstalled) {
      return
    }
    consoleCaptureInstalled = true
    const previousStdoutWrite = process.stdout.write
    const previousStderrWrite = process.stderr.write
    restoreConsoleWriters = () => {
      process.stdout.write = previousStdoutWrite
      process.stderr.write = previousStderrWrite
    }
    const buffers: { stdout: string, stderr: string } = {
      stdout: '',
      stderr: '',
    }
    // Per-stream decoders: a byte chunk can end mid-character, and a plain
    // `toString` would emit U+FFFD for the split code point. The decoder
    // holds the partial sequence until the next chunk completes it. Only the
    // UTF-8 path needs it; a chunk written under an explicit other encoding
    // is decoded as declared.
    const decoders = {
      stdout: new StringDecoder('utf8'),
      stderr: new StringDecoder('utf8'),
    }
    const patch
      = (stream: 'stdout' | 'stderr', raw: typeof process.stdout.write) =>
        (chunk: unknown, encoding?: unknown, cb?: unknown): boolean => {
          if (debugConfig?.enabled) {
            try {
              const enc = typeof encoding === 'string' ? encoding : 'utf8'
              const text
                = typeof chunk === 'string'
                  ? chunk
                  : enc === 'utf8' || enc === 'utf-8'
                    ? decoders[stream].write(Buffer.from(chunk as Uint8Array))
                    : Buffer.from(chunk as Uint8Array).toString(
                        enc as BufferEncoding,
                      )
              const combined = buffers[stream] + text.replace(/\r\n/g, '\n')
              const parts = combined.split('\n')
              buffers[stream] = parts.pop() ?? ''
              for (const line of parts) {
                const trimmed = line.replace(/\s+$/, '')
                if (trimmed) {
                  emit({
                    type: 'sandbox-log',
                    source: bridgeType,
                    stream,
                    line: trimmed,
                  })
                }
              }
            }
            catch {
            // Never let capture break real output.
            }
          }
          return (raw as (c: unknown, e?: unknown, cb?: unknown) => boolean)(
            chunk,
            encoding,
            cb,
          )
        }
    process.stdout.write = patch(
      'stdout',
      previousStdoutWrite.bind(process.stdout),
    ) as typeof process.stdout.write
    process.stderr.write = patch(
      'stderr',
      previousStderrWrite.bind(process.stderr),
    ) as typeof process.stderr.write
  }

  // ─── inbound routing ────────────────────────────────────────────────
  // `stop` / `destroy` reach forward to `drainThenExit`, which closes over the
  // `WebSocketServer` declared below. The reference is safe: `handleInbound`
  // only ever runs from a connection handler, long after both exist.
  /* eslint-disable ts/no-use-before-define */
  const handleInbound = async (
    msg: TStart | InboundControl,
    ws: WebSocket,
  ): Promise<void> => {
    switch (msg.type) {
      case 'start': {
        /*
         * One turn at a time. A second `start` while one is running used to be
         * accepted: it closed the first turn's user-message queue, replaced the
         * abort controller, the interrupt handler and the event log, and left
         * the first `onStart` still running — so both turns emitted onto one
         * stream. The bridge refuses it instead (ADR: turns run through the
         * Agent SDK in a turn host), on the sending socket alone and without
         * touching any state, so the running turn is unharmed.
         */
        if (currentTurnState === 'running') {
          sendControl(ws, {
            type: 'error',
            phase: 'start',
            error: 'a bridge turn is already running',
          })
          return
        }
        activeSocket = ws // asking for a turn claims the event stream
        // A new turn clears the replay log, so nothing stamped before it can
        // ever reach this socket: mark it all delivered rather than leaking a
        // previous turn's queued frames onto a fresh stream.
        deliveredSeq = seqCounter
        currentUserMessages?.close(
          new Error('A new bridge turn replaced the active turn.'),
        )
        const firstTurn = isFirstTurn
        isFirstTurn = false
        eventLog = [] // clear previous turn; keep seqCounter monotonic
        // Mirror the in-memory clear to disk: the journal tracks only the
        // current turn. It goes on the frame chain so it cannot truncate a
        // frame that was already queued for append.
        journalChain = journalChain.then(() =>
          writeFile(eventLogPath, '').catch(() => {}),
        )
        turnAbort = new AbortController()
        currentTurnState = 'running'
        // Acknowledged now, not by the query's first message: a cold `query()` can take longer
        // to say anything than a client is willing to wait for proof that its `start` was
        // taken, and a client that gave up would leave this turn running with nobody attached.
        emit({ type: 'bridge-started' })
        void writeStartConfig(msg)
        void writeBridgeMeta('running')
        const startDebug = (msg as { debug?: BridgeDebugConfig }).debug
        debugConfig = {
          enabled: startDebug?.enabled ?? envDebugEnabled,
          level:
            startDebug?.level
            ?? (procEnv.HARNESS_DEBUG_LEVEL as BridgeDebugLevel | undefined),
          subsystems:
            startDebug?.subsystems
            ?? parseEnvList(procEnv.HARNESS_DEBUG_SUBSYSTEMS),
        }
        if (debugConfig.enabled) {
          installConsoleCapture()
        }
        const userMessages = createBridgeUserMessageQueue({ respond: emit })
        const turn: BridgeTurn = {
          emit,
          requestToolResult: toolCallId =>
            new Promise((resolve) => {
              pendingToolResults.set(toolCallId, resolve)
            }),
          requestToolApproval: approvalId =>
            new Promise((resolve) => {
              pendingToolApprovals.set(approvalId, resolve)
            }),
          experimental_userMessages: userMessages,
          abortSignal: turnAbort.signal,
          journalPath: eventLogPath,
          onInterrupt: (handler) => {
            currentInterrupt = handler
          },
          flush: flushPendingEventsToDisk,
          firstTurn,
          bridgeLog: (input) => {
            const level = input.level ?? 'debug'
            if (!shouldEmitDebugEvent(level, input.subsystem)) {
              return
            }
            emit({
              type: 'debug-event',
              level,
              subsystem: input.subsystem,
              message: input.message,
              ...(input.attrs ? { attrs: input.attrs } : {}),
              ...(input.error !== undefined
                ? { error: formatBridgeError(input.error) }
                : {}),
            })
          },
          emitWarning,
          emitError,
        }
        currentUserMessages = userMessages
        try {
          await onStart(msg as TStart, turn)
        }
        catch (err) {
          emitError({ error: err, message: 'bridge turn failed' })
        }
        finally {
          userMessages.close()
          if (currentUserMessages === userMessages) {
            currentUserMessages = undefined
          }
          currentInterrupt = undefined
          currentTurnState = 'waiting'
          void writeBridgeMeta('waiting')
        }
        return
      }
      case 'tool-result': {
        const resolver = pendingToolResults.get(msg.toolCallId)
        if (resolver) {
          pendingToolResults.delete(msg.toolCallId)
          resolver({ output: msg.output, isError: msg.isError })
        }
        return
      }
      case 'tool-approval-response': {
        const resolver = pendingToolApprovals.get(msg.approvalId)
        if (resolver) {
          pendingToolApprovals.delete(msg.approvalId)
          resolver({ approved: msg.approved, reason: msg.reason })
        }
        return
      }
      case 'user-message': {
        const messageId = msg.messageId ?? randomUUID()
        if (currentUserMessages == null) {
          sendControl(ws, {
            type: 'user-message-response',
            messageId,
            accepted: false,
            error: { message: 'The bridge has no active turn to steer.' },
          })
          return
        }
        if (ws !== activeSocket) {
          sendControl(ws, {
            type: 'user-message-response',
            messageId,
            accepted: false,
            error: {
              message: 'The connection does not own the active bridge turn.',
            },
          })
          return
        }
        currentUserMessages.enqueue({
          messageId,
          text: msg.text,
        })
        return
      }
      case 'abort':
        turnAbort?.abort()
        return
      /*
       * `interrupt` is not `abort`. Abort tears the runtime down and leaves no
       * `result`; an interrupt asks the agent to stop and still finish the
       * turn properly, which only the adapter's runtime knows how to do — so
       * it goes to the handler the turn registered. A second one is the
       * adapter's no-op; one with no turn running is an error on the sending
       * socket alone, never on the event stream.
       */
      case 'interrupt': {
        if (currentInterrupt == null) {
          sendControl(ws, {
            type: 'error',
            phase: 'run',
            error: 'no running turn to interrupt',
          })
          return
        }
        currentInterrupt(msg.reason)
        return
      }
      case 'resume':
        activeSocket = ws // asking for a catch-up claims it too
        // Queued on the journal chain, so nothing reaches the socket before it
        // is on disk and no live frame slips out ahead of the replayed tail.
        replay(ws, msg.lastSeenEventId)
        return
      case 'destroy':
        currentTurnState = 'done'
        void writeBridgeMeta('done')
        await onDestroy?.()
        drainThenExit(ws, 1000, 'destroy')
        return
      case 'stop': {
        currentTurnState = 'done'
        void writeBridgeMeta('done')
        const data = (await onStop?.()) ?? {}
        sendControl(ws, { type: 'bridge-stop', data })
        drainThenExit(ws, 1000, 'stop')
      }
    }
  }
  /* eslint-enable ts/no-use-before-define */

  // ─── server ─────────────────────────────────────────────────────────
  void writeBridgeMeta('init')

  const wss = new WebSocketServer({ port: bridgeWsPort, host: '0.0.0.0' })

  const exit = (): void => {
    if (options.onExit) {
      options.onExit()
      return
    }
    wss.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 1000).unref()
  }

  const drainThenExit = (ws: WebSocket, code: number, reason: string): void => {
    const start = Date.now()
    const tick = (): void => {
      const drained = ws.bufferedAmount === 0 || ws.readyState !== WS_OPEN
      if (drained || Date.now() - start >= 5_000) {
        // Flush the on-disk log so a clean stop/destroy leaves a complete
        // event-log.ndjson for any later replay recovery.
        void flushPendingEventsToDisk().finally(() => {
          try {
            ws.close(code, reason)
          }
          finally {
            exit()
          }
        })
        return
      }
      setTimeout(tick, 10).unref()
    }
    tick()
  }

  wss.on('listening', () => {
    const addr = wss.address()
    currentBoundPort = typeof addr === 'object' && addr ? addr.port : 0
    /*
     * Only ever an `init` → `waiting` promotion. Under bun `wss.address()` is
     * already set when `runBridge` returns (see the await below), so a host can
     * connect and start a turn before this handler runs — and an unconditional
     * assignment would then report a running turn as `waiting`.
     */
    if (currentTurnState === 'init') {
      currentTurnState = 'waiting'
      void writeBridgeMeta('waiting')
    }
    stdout.write(
      `${JSON.stringify({
        type: 'bridge-ready',
        port: currentBoundPort,
      })}\n`,
    )
    options.onListening?.(currentBoundPort)
  })

  wss.on('connection', (ws: WebSocket, req: { url?: string }) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    if (url.searchParams.get('agent_bridge_token') !== expectedToken) {
      ws.close(1008, 'unauthorized')
      return
    }

    // Announce liveness the instant we accept. Some sandbox runtimes complete
    // the host-side WS handshake before the connection is forwarded here; the
    // host waits for this frame before sending `start`/`resume`.
    sendControl(ws, {
      type: 'bridge-hello',
      state: currentTurnState,
      lastSeq: seqCounter,
      capabilities: { experimental_userMessageResponses: true },
    })

    ws.on('message', (raw: ArrayBufferLike | string) => {
      let parsed: TStart | InboundControl
      try {
        const text
          = typeof raw === 'string' ? raw : Buffer.from(raw).toString('utf8')
        parsed = JSON.parse(text) as TStart | InboundControl
      }
      catch (err) {
        sendControl(ws, {
          type: 'error',
          error: `protocol parse error: ${(err as Error).message}`,
        })
        return
      }
      void handleInbound(parsed, ws)
    })

    ws.on('close', () => {
      // Only the stream owner's close matters; a socket that never claimed it,
      // or that a later `start`/`resume` displaced, closes as a no-op.
      // Crucially we do NOT abort the in-flight turn: it keeps running and its
      // events accumulate in the log for replay on reconnect.
      if (activeSocket === ws) {
        activeSocket = undefined
      }
    })

    ws.on('error', () => {
      // 'close' follows; nothing to do beyond keeping the process alive.
    })
  })

  /*
   * Surface bridge-internal crashes to the host, then die. Upstream swallowed
   * both events to keep the bridge alive, but a process that continues past
   * an uncaught throw serves the next `start` or `resume` from a state nobody
   * can reason about, and a non-zero exit is the one signal every sandbox
   * backend surfaces. The journal is flushed first so the frame outlives the
   * process. Named so `close` can remove them: every `runBridge` in one
   * process would otherwise leave its listeners behind, and a crash after a
   * bridge closed would still route through that bridge's `emitError`.
   */
  const crash = (err: unknown, message: string): void => {
    emitError({ error: err, message })
    void flushPendingEventsToDisk().finally(() => {
      if (options.onExit) {
        options.onExit()
        return
      }
      process.exit(1)
    })
  }
  const onUncaughtException = (err: unknown): void => {
    crash(err, 'uncaught exception')
  }
  const onUnhandledRejection = (err: unknown): void => {
    crash(err, 'unhandled rejection')
  }
  process.on('uncaughtException', onUncaughtException)
  process.on('unhandledRejection', onUnhandledRejection)

  await new Promise<void>((resolve, reject) => {
    const address = wss.address()
    if (address != null) {
      /*
       * Under bun, `ws` reports its address before the `listening` event
       * fires, so this branch is taken and the handler above has not yet set
       * `currentBoundPort` — `BridgeHandle.port` would read 0. Take it from
       * the address we already have. (Under node `address()` is null until
       * `listening`, so this branch never runs there.)
       */
      if (currentBoundPort === 0 && typeof address === 'object') {
        currentBoundPort = address.port
      }
      /*
       * Same promotion the `listening` handler performs, done now: a host can
       * connect in the gap before that handler runs, and it must find the
       * bridge `waiting`, not `init`. The handler's own guard then no-ops.
       */
      if (currentTurnState === 'init') {
        currentTurnState = 'waiting'
        void writeBridgeMeta('waiting')
      }
      resolve()
      return
    }

    wss.once('listening', resolve)
    wss.once('error', reject)
  })

  return {
    port: currentBoundPort,
    close: () =>
      new Promise<void>((resolve) => {
        process.removeListener('uncaughtException', onUncaughtException)
        process.removeListener('unhandledRejection', onUnhandledRejection)
        // Undo the console capture too: a later bridge in the same process
        // would otherwise write through this one's patch and journal its
        // output here.
        if (consoleCaptureInstalled) {
          restoreConsoleWriters?.()
          restoreConsoleWriters = undefined
          consoleCaptureInstalled = false
        }
        wss.close(() => resolve())
      }),
  }
}

/*
 * Control frames answer the socket that sent the frame they reply to, so the
 * target is always explicit. Event streaming is the separate, stateful path
 * (`emit` → `activeSocket`); this one carries no state at all.
 */
function sendControl(
  socket: WebSocket | undefined,
  message: Record<string, unknown>,
): void {
  if (socket?.readyState === WS_OPEN) {
    try {
      socket.send(JSON.stringify(message))
    }
    catch {
      // best-effort
    }
  }
}

function serialiseError(err: unknown): unknown {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack }
  }
  return err
}
