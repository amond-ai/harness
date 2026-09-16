// Long-running bridge that runs inside a sandbox alongside the `codex` CLI.
// The generic transport — WebSocket server, token auth, single-flight
// reconnect, the in-memory event log + `seq`, resume replay, and the
// lifecycle/meta files — lives in the shared bridge runtime. This file supplies
// only the Codex-specific turn driver.
//
// `@openai/codex-sdk` is not imported here: the `Codex` constructor arrives
// through `createTurnDriver`, so a test can drive the whole driver against a
// scripted fake and `main.ts` stays the one module that loads the real SDK.

import type { BridgeEvent, BridgeTurn, InterruptReason } from '@amond-ai/harness-bridge-runtime'
import type { StartMessage } from '@amond-ai/harness-protocol/codex'
import type { CodexEvent } from './create-emit-stream-event'
import { env as procEnv } from 'node:process'
import { startMessageSchema } from '@amond-ai/harness-protocol/codex'
import { createCodexStepTracker, defaultUsage } from './codex-step-tracker'
import { createEmitStreamEvent } from './create-emit-stream-event'

/**
 * One streamed Codex turn, as much of `@openai/codex-sdk`'s `Thread` as this
 * host uses.
 */
export interface CodexThreadLike {
  runStreamed: (
    input: string,
    turnOptions?: { signal?: AbortSignal, outputSchema?: unknown },
  ) => Promise<{ events: AsyncIterable<CodexEvent> }>
}

/** The SDK's `Codex` client, as much of it as this host uses. */
export interface CodexLike {
  startThread: (options?: Record<string, unknown>) => CodexThreadLike
  resumeThread: (id: string, options?: Record<string, unknown>) => CodexThreadLike
}

/**
 * The `new Codex(...)` seam. `main.ts` passes the real SDK constructor; tests
 * pass a fake that yields a scripted event script and records what it was
 * constructed and run with.
 *
 * Structural rather than the SDK's own types, and that is deliberate: the
 * options this host builds are wider than `CodexOptions`/`ThreadOptions`
 * declare — `config` is an open TOML-shaped record, and `model_providers` under
 * it is whatever the CLI's config accepts. Upstream casts the whole module to
 * `any` to get past that; naming the two methods it actually calls keeps the
 * call sites checked and confines the cast to one line in `main.ts`.
 */
export type CodexFactory = (options: Record<string, unknown>) => CodexLike

export interface TurnDriverOptions {
  createCodex: CodexFactory
  /** Absolute path the turn runs in; `workingDirectory` for every thread. */
  workdir: string
}

/**
 * The two halves of the adapter the bridge runtime drives: one turn, and the
 * resume coordinate a future process picks the session up by.
 */
export interface CodexTurnDriver {
  onStart: (start: StartMessage, turn: BridgeTurn) => Promise<void>
  /**
   * The thread this process is on, for the runtime's `stop` reply.
   *
   * A thread id survives the turn that created it — it is the only coordinate
   * a later process can resume by, and `~/.codex/sessions` is where the thread
   * itself lives. Held in this closure rather than at module scope so a test
   * can stand up two independent drivers in one process.
   *
   * Aborts an in-flight turn on the way out: `stop` is dispatched without
   * waiting for the turn, and the runtime hard-exits the process right after,
   * so a `codex exec` child whose signal was never aborted is left orphaned.
   */
  onStop: () => { threadId?: string }
  /** The same teardown for `destroy`, which sends no reply. */
  onDestroy: () => void
}

type Emit = (msg: Record<string, unknown>) => void

/**
 * Build the adapter the bridge runtime drives. Everything the driver needs
 * beyond the `start` frame is closed over here, so the module has no
 * module-level state and no import of the real SDK.
 */
export function createTurnDriver(
  driverOptions: TurnDriverOptions,
): CodexTurnDriver {
  const threadState: { id: string | undefined } = { id: undefined }
  /*
   * The controller of the turn running right now, hoisted out of `runTurn` so
   * the lifecycle commands can reach it. Without it `stop`/`destroy` exit the
   * process with the SDK's signal never aborted, and the `codex exec` child —
   * spawned without `detached`, torn down only through that signal — outlives
   * the parent with `runStreamed`'s own cleanup never run.
   */
  const activeRun: ActiveRun = { ctl: undefined, lifecycleStopped: false }
  const abortActiveRun = (): void => {
    /*
     * A lifecycle teardown, like a client `abort`: the turn it cut short gets
     * no ending. The process is exiting on the next tick, so an `error` or a
     * `finish` emitted on the way out would only describe the teardown as an
     * outcome of the turn.
     */
    activeRun.lifecycleStopped = true
    activeRun.ctl?.abort()
  }
  return {
    onStart: (start, turn) =>
      runTurn(start, turn, driverOptions, threadState, activeRun),
    onStop: () => {
      abortActiveRun()
      return threadState.id === undefined ? {} : { threadId: threadState.id }
    },
    onDestroy: abortActiveRun,
  }
}

/** The in-flight turn's abort handle, and whether a lifecycle command used it. */
interface ActiveRun {
  ctl: AbortController | undefined
  lifecycleStopped: boolean
}

async function runTurn(
  startFrame: StartMessage,
  turn: BridgeTurn,
  driverOptions: TurnDriverOptions,
  threadState: { id: string | undefined },
  activeRun: ActiveRun,
): Promise<void> {
  const { createCodex, workdir } = driverOptions
  const emit: Emit = msg => turn.emit(msg as BridgeEvent)

  /*
   * Every frame this host sends is journaled, including the text and reasoning
   * deltas — the Claude bridge's one live-only class has no counterpart here.
   * There, a delta is a duplicate: the same text arrives again on the `raw`
   * frame carrying the whole SDK message. Codex emits no `raw` frames, so the
   * deltas *are* the transcript, and a reconnect that did not replay them
   * would hand the client a turn with its text missing.
   */

  /*
   * The `start` frame is untrusted JSON off a socket. Validate it here rather
   * than trusting the static type: a run configured with a field the host
   * cannot honour must not start at all.
   */
  const parsed = startMessageSchema.safeParse(startFrame)
  if (!parsed.success) {
    emit({
      type: 'error',
      phase: 'start',
      error: `invalid start message: ${parsed.error.message}`,
      journalPath: turn.journalPath,
    })
    return
  }
  const start = parsed.data

  const refusal = unsupportedStartField(start)
  if (refusal !== undefined) {
    emit({
      type: 'error',
      phase: 'start',
      error: refusal,
      journalPath: turn.journalPath,
    })
    return
  }

  /*
   * Cross-process resume: the client carries the thread id this bridge
   * announced on `bridge-thread` or returned on `stop`, and sends it back so
   * the SDK call below takes the `resumeThread` branch. `restartThread` is the
   * explicit opposite — forget the thread this process is on and start a fresh
   * one — and it wins over a `resumeThreadId` sent with it.
   */
  if (start.restartThread) {
    threadState.id = undefined
  }
  else if (
    typeof start.resumeThreadId === 'string'
    && start.resumeThreadId.length > 0
  ) {
    threadState.id = start.resumeThreadId
  }

  const codexConfig = buildCodexConfig(start)
  const apiBaseUrl = resolveApiBaseUrl(start)
  /*
   * Constructing the client and opening the thread are the last steps that can
   * throw before there is a stream to report on. Left to the runtime's own
   * catch they reach the client as a run error with no `journalPath` — the one
   * field that says where the turn's transcript is — so the ending is emitted
   * here, where the journal is in scope.
   */
  let thread: CodexThreadLike
  try {
    const codex = createCodex({
      ...(procEnv.CODEX_API_KEY ? { apiKey: procEnv.CODEX_API_KEY } : {}),
      /*
       * Only when no `model_providers` entry was configured above: the CLI reads
       * the provider's `base_url` in that case, and passing both leaves two
       * sources for one setting.
       */
      ...(typeof codexConfig.model_provider === 'string' || apiBaseUrl === undefined
        ? {}
        : { baseUrl: apiBaseUrl }),
      /*
       * The credentials the turn runs on arrive here and nowhere else.
       *
       * `env` REPLACES the CLI child's environment rather than merging into it,
       * so the whole of this process's environment is forwarded — which is what
       * the consumer's `env: () => Record<string, string>` thunk populated when
       * the sandbox exec'd this bridge. Upstream's `codex-subscription.ts`, which
       * reads `~/.codex/auth.json` or the OS keyring and refreshes the OAuth
       * token itself, is deliberately not ported: this repository has no
       * credential-brokering primitive to build it on, and a host that reached
       * into a keyring would be a host the sandbox contract cannot describe.
       */
      env: Object.fromEntries(
        Object.entries(procEnv).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      ),
      ...(Object.keys(codexConfig).length > 0 ? { config: codexConfig } : {}),
    })

    const threadOptions: Record<string, unknown> = {
      ...(start.model ? { model: start.model } : {}),
      /*
       * The sandbox is the isolation boundary, not the CLI: everything this
       * process can reach, the turn is already allowed to reach. A second
       * sandbox inside the first would only make the agent fail at things the
       * deployment means to permit.
       */
      sandboxMode: 'danger-full-access',
      /*
       * Load-bearing, not a default. `codexTurnHostFinishSchema` has no
       * `deferredToolUse` *because* of this line: under `never` a turn cannot
       * park on a decision, so there is no deferral for an ending to name. A
       * bridge that wants approvals needs the schema changed first, rather than
       * a field that is already waiting.
       */
      approvalPolicy: 'never',
      workingDirectory: workdir,
      skipGitRepoCheck: true,
      ...(start.reasoningEffort
        ? { modelReasoningEffort: start.reasoningEffort }
        : {}),
      webSearchMode: start.webSearch ? 'live' : 'disabled',
    }

    thread = threadState.id === undefined
      ? codex.startThread(threadOptions)
      : codex.resumeThread(threadState.id, threadOptions)
  }
  catch (err) {
    turn.emitError({
      error: err,
      message: 'codex turn setup failed',
      phase: 'run',
      journalPath: turn.journalPath,
    })
    return
  }

  /*
   * The controller the SDK turn actually runs on, aborted by either of the two
   * commands that end a turn early — but they are not the same ending.
   *
   * `abort` is the client tearing the turn down and expects no `result`;
   * `interrupt` asks for the turn to stop and still be reported. The Codex SDK
   * has one lever for both — `runStreamed`'s `signal` — and no counterpart to
   * the Claude query's `interrupt()`, which winds the CLI down and yields a
   * typed result. So an interrupt here is that same abort, and what makes it a
   * turn rather than a teardown is this host: it remembers the reason and ends
   * the turn with a `finish { stopped: 'interrupted' }` carrying whatever the
   * turn produced before the stop. There is no escalation timer for the same
   * reason — the abort is the escalation.
   */
  const runCtl = new AbortController()
  // Published for the whole of this turn, so `stop` and `destroy` can abort the
  // SDK — and therefore the CLI child — before the process exits.
  activeRun.ctl = runCtl
  // Remembered rather than only acted on: the ending this host reports echoes the reason back,
  // because the client's own memory of the stop it asked for does not survive a step that never
  // committed — and without the echo the ending reads as an unnamed timeout.
  let interruptReason: InterruptReason | undefined
  if (turn.abortSignal.aborted) {
    runCtl.abort()
  }
  else {
    turn.abortSignal.addEventListener('abort', () => runCtl.abort(), {
      once: true,
    })
  }
  turn.onInterrupt((reason) => {
    if (interruptReason !== undefined) {
      return
    }
    interruptReason = reason
    runCtl.abort()
  })

  /*
   * Codex takes one prompt per turn and offers no way to inject another while
   * it runs. The runtime still accepts `user-message` on the wire and queues it
   * for whatever adapter is driving, so the queue is drained and each message
   * refused *now*. Left undrained it is answered anyway — the runtime rejects
   * every unanswered entry when it closes the queue — but not until the turn
   * ends, which is precisely the wait a mid-turn message was sent to avoid.
   */
  void rejectUserMessages(turn)

  emit({ type: 'stream-start' })

  let turnUsage: Record<string, unknown> | undefined
  /*
   * `finish` and `error` are alternative endings, so the first terminal error
   * latches and the `finish` below is suppressed. Codex reports a failed turn
   * as an event in the stream rather than by throwing, so without the latch a
   * turn that failed would be reported as having failed *and* then finished.
   */
  let emittedTerminalError = false
  const emitTerminalError = (input: { error: unknown, message: string }): void => {
    if (emittedTerminalError) {
      return
    }
    emittedTerminalError = true
    turn.emitError({
      error: input.error,
      message: input.message,
      phase: 'run',
      journalPath: turn.journalPath,
      // A failure that lands during the wind-down is the interrupt's ending too; the key is
      // omitted on every failure no stop preceded.
      ...(interruptReason === undefined ? {} : { interruptedBy: interruptReason }),
    })
    /*
     * The turn has been given its ending, so nothing after it belongs on the
     * stream. Codex's own terminal events do close the stream, but a frame
     * emitted after an `error` is a frame the client reads past an outcome it
     * has already acted on — this makes that unreachable rather than merely
     * unlikely.
     */
    runCtl.abort()
  }

  const stepTracker = createCodexStepTracker({ send: emit })
  const emitStreamEvent = createEmitStreamEvent({
    send: emit,
    stepTracker,
    setTurnUsage: (usage) => {
      turnUsage = usage
    },
    setThreadId: (threadId) => {
      threadState.id = threadId
    },
    emitWarning: turn.emitWarning,
    emitTerminalError,
  })

  /*
   * `runStreamed`'s events are a bare `AsyncIterable` with no guarantee that a
   * terminal event precedes its end, so an iterable that simply runs dry — the
   * CLI child dying mid-turn — is a truncated turn rather than a completed one.
   * Only a `turn.completed` this loop actually saw earns a completed `finish`.
   */
  let sawTurnCompleted = false
  try {
    const { events } = await thread.runStreamed(start.prompt, {
      signal: runCtl.signal,
      ...(start.responseFormat?.type === 'json'
        && start.responseFormat.schema != null
        ? { outputSchema: start.responseFormat.schema }
        : {}),
    })
    for await (const event of events) {
      if (runCtl.signal.aborted) {
        break
      }
      if (event.type === 'turn.completed') {
        sawTurnCompleted = true
      }
      emitStreamEvent(event)
    }
  }
  catch (err) {
    /*
     * An abort is never the SDK's own failure. Every abort of `runCtl` is one
     * this host asked for — a client `abort`, or an `interrupt` — and both are
     * accounted for below, so the rejection that follows is that abort landing
     * rather than a turn that broke.
     */
    if (!runCtl.signal.aborted) {
      emitTerminalError({ error: err, message: 'codex turn failed' })
    }
  }
  finally {
    // The turn is over: a later `stop` has nothing of this turn's to abort.
    if (activeRun.ctl === runCtl) {
      activeRun.ctl = undefined
    }
  }

  if (emittedTerminalError) {
    return
  }
  /*
   * A client `abort` is a teardown it asked for, and the runtime's own
   * contract is that it leaves no result — so it gets no `finish` either. An
   * `interrupt` aborted the same signal and does, which is the whole
   * difference between the two commands.
   */
  if (turn.abortSignal.aborted || activeRun.lifecycleStopped) {
    return
  }

  /*
   * No terminal event and no stop asked for: the stream ended on its own part
   * way through. Reporting that as a completed turn would hand the client a
   * truncated transcript under the one ending that says nothing went wrong.
   */
  if (!sawTurnCompleted && interruptReason === undefined) {
    emitTerminalError({
      error: 'codex stream ended without a terminal event',
      message: 'codex stream ended before the turn completed',
    })
    return
  }

  const stopped = interruptReason === undefined ? 'completed' : 'interrupted'
  emit({
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    totalUsage: turnUsage ?? defaultUsage(),
    stopped,
    journalPath: turn.journalPath,
    ...(stopped === 'interrupted' ? { interruptedBy: interruptReason } : {}),
  })
}

/**
 * The reason to refuse this `start`, or `undefined` to run it.
 *
 * Every field named here is one the wire schema accepts and this host has no
 * way to honour. Refusing is the point: a turn that ran with more access than
 * it asked for, or without the tools it asked for, is worse than a turn that
 * did not run — and each of these would be exactly that, silently.
 */
function unsupportedStartField(start: StartMessage): string | undefined {
  /*
   * Host-defined tools are not part of this deployment's contract. Upstream
   * routes them through an HTTP relay and a CLI shim it writes into the
   * sandbox, working around a Codex bug that leaves MCP tools unregistered;
   * the client never sends the field.
   */
  if (start.tools && start.tools.length > 0) {
    return 'start.tools is not supported by this turn host'
  }
  /*
   * The thread runs `sandboxMode: 'danger-full-access'`, which is what
   * `allow-all` names. The two narrower modes have Codex equivalents
   * (`read-only`, `workspace-write`) but no client has asked for them, and
   * guessing the mapping is how a turn ends up with more access than it
   * requested.
   */
  if (start.permissionMode !== undefined && start.permissionMode !== 'allow-all') {
    return `start.permissionMode '${start.permissionMode}' is not supported by this turn host`
  }
  /* Codex exposes no allow/deny list over its own built-in tools. */
  if (start.builtinToolFiltering !== undefined) {
    return 'start.builtinToolFiltering is not supported by this turn host'
  }
  return undefined
}

/**
 * The `--config` overrides the CLI child runs with: the client's own, plus what
 * this host sets on top.
 */
function buildCodexConfig(start: StartMessage): Record<string, unknown> {
  const codexConfig: Record<string, unknown> = {
    ...start.codexConfig,
    developer_instructions: [
      start.instructions,
      'Only respond with your `final` message once you have fully addressed the user request.',
    ]
      .filter((instruction): instruction is string => Boolean(instruction))
      .join('\n\n'),
    model_reasoning_summary: 'detailed',
  }

  const apiBaseUrl = resolveApiBaseUrl(start)
  if (apiBaseUrl !== undefined) {
    /*
     * A named provider rather than a bare `base_url`, because that is the only
     * shape the CLI takes per-request headers and a wire API in.
     */
    codexConfig.preferred_auth_method = 'apikey'
    codexConfig.model_provider = 'agent_bridge_openai'
    codexConfig.model_providers = {
      agent_bridge_openai: {
        name: procEnv.CODEX_MODEL_PROVIDER_NAME || 'Agent Bridge OpenAI',
        base_url: apiBaseUrl,
        env_key: 'CODEX_API_KEY',
        wire_api: 'responses',
        supports_websockets: false,
        ...(start.headers != null ? { http_headers: start.headers } : {}),
      },
    }
  }
  if (start.mcpServers != null) {
    codexConfig.mcp_servers = start.mcpServers
  }
  return codexConfig
}

/**
 * Where the turn's model requests go, or `undefined` to leave that to the CLI's
 * own configuration and the credentials it finds.
 *
 * `start.headers` forces the default OpenAI endpoint even when nothing named
 * one: headers can only be attached to a configured provider, so a `start` that
 * sends them but names no base URL would otherwise have them dropped.
 */
function resolveApiBaseUrl(start: StartMessage): string | undefined {
  return (
    procEnv.OPENAI_BASE_URL
    ?? (start.headers != null ? 'https://api.openai.com/v1' : undefined)
  )
}

/**
 * Drain the runtime's user-message queue, refusing each message. See the call
 * site: Codex has no mid-turn input, and a refusal a client can act on is worth
 * more than the same refusal at the end of the turn.
 */
async function rejectUserMessages(turn: BridgeTurn): Promise<void> {
  for await (const message of turn.experimental_userMessages) {
    message.reject(
      new Error('this turn host does not accept a message mid-turn: codex takes one prompt per turn'),
    )
  }
}
