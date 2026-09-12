/**
 * `run` and `spawn` over the contract's `exec`, and the stream split that makes them fit.
 *
 * Two shapes disagree here. The harness passes a **shell string**; `SandboxCommand` is argv,
 * deliberately — `claude-argv.ts` depends on no shell being involved. So the shell is named
 * explicitly, `['sh', '-c', command]`, which puts the whole command in one argv element. A
 * backend that has to render argv back into a shell word list quotes each element
 * conservatively (`packages/amond-ai/sandbox-e2b/src/shell-quote.ts`), and the wrapping survives that:
 * `quoteArgv(['sh', '-c', `echo 'hi' && printf "%s\n" $HOME; false`])` renders
 * `'sh' '-c' 'echo '\''hi'\'' && printf "%s\n" $HOME; false'`, which run through `sh -c`
 * prints `hi` and the expanded `$HOME` and exits 1 — the operators, the nested quotes and the
 * exit code all intact (measured against `shell-quote.ts` on 2026-08-25).
 *
 * And the harness wants `stdout` and `stderr` as two byte streams, while the contract hands
 * back one `ReadableStream<ProcessLogEvent>` with the source tagged per event. The split is
 * written here rather than imported from `apps/cf-orchestrator/src/run/process-ndjson.ts`:
 * that one is app code and carries semantics this surface has no business inheriting — a
 * side channel of exit codes and truncation notices, and a bounded stderr tail.
 */
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import type { ProcessLogEvent, SandboxProcessHandle, SandboxSession } from '@amond-ai/sandbox'
import { bestEffort, nowAborted } from './best-effort'

/** The process half of the harness session. */
export type HarnessProcessSurface = Pick<HarnessV1NetworkSandboxSession, 'run' | 'spawn'>

type ProcessOptions = Parameters<HarnessV1NetworkSandboxSession['spawn']>[0]
type HarnessProcess = Awaited<ReturnType<HarnessV1NetworkSandboxSession['spawn']>>
type RunResult = Awaited<ReturnType<HarnessV1NetworkSandboxSession['run']>>

export interface ProcessSurfaceOptions {
  sandbox: SandboxSession
  /** Where a command runs when the caller names no `workingDirectory`. */
  defaultWorkingDirectory: string
}

/** A started process, and the way to take its abort listener back off the caller's signal. */
interface StartedProcess {
  handle: SandboxProcessHandle
  /**
   * Undo the `addEventListener` below — idempotent, and a no-op when there is no signal.
   *
   * Handed back rather than kept private because the listener outlives this function by
   * design and only this function holds the closure that identifies it. Every later exit that
   * refuses the spawn has to be able to take it off, and none of them can name it.
   */
  detach: () => void
}

/**
 * Start the command, with both of the guards that keep an aborted caller from leaking it.
 *
 * The two guards and the `exec` between them are one unit — the window the second guard
 * closes is exactly this function's `await` — so they are read together or not at all.
 */
async function startProcess(
  options: ProcessSurfaceOptions,
  processOptions: ProcessOptions,
): Promise<StartedProcess> {
  // Refuse before anything starts. A listener attached to an already-aborted signal never
  // fires — the DOM spec fires `abort` exactly once, confirmed under Bun 1.3.14 — so
  // wiring one up and returning would leave a live process in the sandbox for a caller
  // that has already cancelled, with no handle left to kill it. Refusing is also what the
  // platform does (`fetch` rejects on a pre-aborted signal, which is what
  // `throwIfAborted()` is for) and what provider-utils' own `connectToWebSocket` documents
  // for the same case; and unlike start-then-kill, whose kill is async and can itself
  // fail, it cannot leak. `throwIfAborted()` throws `signal.reason`, so the value a caller
  // sees here is the same one `wait()` would have rejected with.
  processOptions.abortSignal?.throwIfAborted()

  const handle = await options.sandbox.exec(['sh', '-c', processOptions.command], {
    cwd: processOptions.workingDirectory ?? options.defaultWorkingDirectory,
    env: processOptions.env,
  })
  const { abortSignal } = processOptions

  // Listener first, then the check — and that order is the whole point of these two lines.
  //
  // Abort handling here is two guards: `throwIfAborted()` above, for a signal aborted before
  // `spawn` was entered, and this listener, for one that fires after it is attached. Whatever
  // sits between them is a window, and `await exec` is a remote call, so the window is wide in
  // wall-clock terms. `abort` is one-shot, so a listener attached after the fact never runs —
  // the same DOM behaviour the pre-check exists for. An abort landing in the window therefore
  // left the command running in the sandbox with no kill ever issued, while `wait()` still
  // rejected with the reason: the caller was told it had cancelled something that was in fact
  // still running. That is the second instance of this one bug class on this path.
  //
  // Attaching first cannot fire for an abort that already happened, so it only ever covers
  // forwards; the `aborted` read then covers everything backwards to the pre-check, and there
  // is no `await` between the two lines for an abort to slip into. Check-then-attach would
  // reopen a smaller version of the same window instead of closing it.
  //
  // Killing and then throwing the reason keeps the contract the pre-check already set: a
  // caller that aborted gets a rejection, never a live process it holds no handle for.
  //
  // The pre-check calls the listener's own closure rather than awaiting a kill of its own,
  // and that is the whole difference between starting the cleanup and waiting for it.
  // `kill()` is an RPC into the sandbox, so a backend slow or stuck there would hold the
  // rejection back for as long as it hung — this guard's own bug class, a call outliving the
  // signal that cancelled it, reintroduced by the line that refuses the call. Nothing reads
  // the outcome either way, since `bestEffort` discards both the value and the failure, so
  // the wait bought only the delay. A listener cannot await at all, which is why the two
  // halves of one guard disagreed about one call until they were the same call (#273).
  //
  // What that costs, stated rather than left for a reader to find: under workerd a promise
  // that is neither awaited nor handed to `waitUntil` is cancelled when the request's I/O
  // context is torn down, so a handler returning right after this rejection could cancel the
  // kill before it lands — the leak this guard exists to close, arriving by another route.
  // Awaiting is still not the answer, because it reinstates the hang above and because the
  // listener has floated since #268 and cannot do otherwise; the answer is a `waitUntil`-style
  // hook on {@link ProcessSurfaceOptions}, which needs a caller to thread one from and this
  // package has none yet. Named here so the next reader inherits the trade-off, not just the
  // choice (review, PR #274).
  const killProcess = (): void => void bestEffort(() => handle.kill())
  abortSignal?.addEventListener('abort', killProcess, { once: true })
  const detach = (): void => {
    abortSignal?.removeEventListener('abort', killProcess)
  }
  if (abortSignal?.aborted === true) {
    // Taken off again, which `{ once: true }` cannot do here: that collects a listener when it
    // *fires*, and this one never will — `abort` already fired, which is why the check exists
    // at all. Left on, it holds `handle` and this closure for as long as the caller holds the
    // signal, and one signal serves a whole turn: `files.ts`'s `collect` removes its own in a
    // `finally` for the same reason. `spawn` detaches on the other exit that refuses a spawn,
    // the one where {@link openLogStream} throws; what neither of them touches is the way out
    // below, where the listener is the guard and killing a later abort is its whole job
    // (gemini review, PR #274).
    detach()
    killProcess()
    throw abortSignal.reason
  }

  return { handle, detach }
}

/**
 * Subscribe to the process log, killing the command if the subscription never opens.
 *
 * Third window, same bug class as the two in {@link startProcess}, reached from the other
 * side: `exec` has returned, so the command *is* running, and a rejection here propagates out
 * of `spawn` with no handle for the caller to kill it with. Nothing else would ever kill it —
 * the caller believes the spawn failed, and the sandbox outlives the call. So the failure
 * kills first and then rethrows: the kill is best-effort (a kill that failed too would
 * otherwise replace "the log stream never opened" with its own error and send the caller
 * after the wrong call), and the cause is the one worth having — except for a caller that
 * aborted, whose own reason is, per the last paragraph below.
 *
 * And the fifth window, which is this `await` — the last one `spawn` has left, and the first
 * where the leak the other four guards exist for cannot happen. {@link startProcess}'s
 * listener is attached before this call and `abort` fires it, so an abort landing here does
 * kill the command; what neither that listener nor `wait()`'s guard touches is the call
 * `spawn` is suspended in. Hence the two halves added here, and nothing more:
 *
 * - the `signal`, because a subscription opened without one has nothing to cancel it. The
 *   listener kills the process, this promise stays pending, and `spawn()` never settles for a
 *   caller that has already cancelled — a hang, not a leak, which is why no existing guard
 *   sees it. `ProcessLogsOptions.signal` is on the contract, so it costs a field.
 * - the recheck, because a backend may ignore that signal, and even one that honours it can
 *   lose the race to an abort landing after `logs()` resolved. Returning then hands the caller
 *   a process whose command the listener has just killed, where an abort one millisecond
 *   earlier — either of the windows above — would have rejected. The subscription is released
 *   (nobody will read it) and the reason thrown; the kill is deliberately *not* repeated,
 *   because the listener already issued it (codex review, PR #268).
 *
 * Whether the cleanup is waited on turns on who is waiting, which is why the `catch` branches
 * on the signal and the recheck does not.
 *
 * For a caller that has cancelled — the recheck, and the `catch`'s aborted branch — the
 * cleanup is started and never waited on, for the reason {@link startProcess}'s pre-check
 * gives: `kill()` and `cancel()` are RPCs into the sandbox, and awaiting one hands a hung
 * backend the power to delay a rejection that caller is already owed.
 *
 * For a caller that has *not* — the `catch`'s other branch — the kill is awaited, and the
 * answer is re-read afterwards, since a caller can abort inside a wait that is an RPC. The
 * ordering the await buys is the point rather than the outcome. `bestEffort` discards the outcome
 * either way, but awaiting still guarantees the kill has been issued *before* the failure
 * reaches a caller that is still waiting for a result and may retry the moment it arrives.
 * `sandbox-e2b` pins exactly that ordering one layer down — `kill() does not resolve until the
 * walk has actually reaped the process`, whose comment names the retry that would otherwise
 * clone into the same checkout while the previous process tree was still being killed (codex
 * and cubic reviews, PR #260). Nothing is racing a rejection here that nobody asked for, so
 * the delay costs the caller nothing it did not already spend on the failed `logs()` call
 * (codex review, PR #274).
 *
 * The `catch` restores the reason for the same purpose {@link waitForProcessExit}'s does: once
 * the signal is forwarded, an abort surfaces here as whatever the backend raises for a
 * cancelled read, and a caller handed that cannot recognise its own abort.
 */
async function openLogStream(
  handle: SandboxProcessHandle,
  abortSignal: AbortSignal | undefined,
): Promise<ReadableStream<ProcessLogEvent>> {
  let events: ReadableStream<ProcessLogEvent>
  try {
    // `replay` alongside `follow`, not `follow` alone: the contract calls `replay` "read the
    // retained log from the beginning rather than from the live tail", so a subscription
    // without it starts at the tail and misses whatever the command already wrote — a fast
    // `echo` here, the bridge's startup banner in the real caller, both written between
    // `exec` returning and this line (codex review, PR #268). `@cloudflare/sandbox` asks for
    // the pair everywhere it reads a whole turn: `consumeLogs`, which backs `waitForExit`
    // and `output`, and `waitForPortSubscriptions` both open `{ replay: true, follow: true }`.
    events = await handle.logs({ follow: true, replay: true, signal: abortSignal })
  }
  catch (cause) {
    if (abortSignal?.aborted === true) {
      void bestEffort(() => handle.kill())
      throw abortSignal.reason
    }
    await bestEffort(() => handle.kill())
    // Asked again, after the await rather than before it, because the await is long enough to
    // change the answer: this branch was chosen for a caller that had not cancelled, and it
    // then waits for a kill that is an RPC into the sandbox. A caller aborting inside that
    // wait is exactly the case the wait exists for — the slow kill — and handing it the
    // backend's log-open error would leave it unable to recognise its own cancellation, which
    // every other abort site here is written to prevent. {@link nowAborted} rather than the
    // comparison spelled inline, because the branch above narrowed `aborted` to `false` and
    // TypeScript then rejects re-reading it (TS2367, measured here as well as in `files.ts`).
    throw nowAborted(abortSignal) ? abortSignal.reason : cause
  }
  if (abortSignal?.aborted === true) {
    void bestEffort(() => events.cancel())
    throw abortSignal.reason
  }
  return events
}

/** Await the exit, naming the abort reason the harness promises for a cancelled wait. */
async function waitForProcessExit(
  handle: SandboxProcessHandle,
  abortSignal: AbortSignal | undefined,
): Promise<{ exitCode: number }> {
  // Refuse before asking the backend, for the reason `spawn`'s own pre-check gives one
  // call earlier: `abort` is one-shot, so a backend wait that only registers a listener
  // on an already-aborted signal never settles, and the caller hangs on a process it has
  // already cancelled. Nothing in the contract obliges a backend to reject that wait —
  // `@cloudflare/sandbox` does check upfront, but that is its choice, not the contract's
  // — so the guard belongs here, where every backend passes (cubic review, PR #268).
  // `throwIfAborted()` throws `signal.reason`, which is the same value the `catch` below
  // restores, so the caller sees one rejection value however the abort was timed.
  abortSignal?.throwIfAborted()
  try {
    return { exitCode: (await handle.waitForExit({ signal: abortSignal })).code }
  }
  catch (cause) {
    // The harness names the rejection value for an aborted spawn: `wait()` rejects with
    // the abort *reason*. The contract leaves what an aborted wait rejects with to the
    // backend, so the reason is restored here — otherwise a caller cannot recognise its
    // own abort and would report a transport failure instead.
    throw abortSignal?.aborted === true ? abortSignal.reason : cause
  }
}

/**
 * Drain both streams and the exit for `run`, killing the command if the drain fails.
 *
 * Fourth window, same bug class as the three `spawn` goes through — and the one their guards
 * cannot reach. `run` swallows the handle: it returns collected output, so a rejection from
 * the collection propagates out with nothing left for the caller to kill with, and `spawn` has
 * returned by now so the command is running. {@link openLogStream}'s guard covers `logs()`
 * failing *before* a stream exists; a stream that errors while `Response(...).text()` is
 * draining it — a mid-run sandbox log-stream reset — is past it (codex review, PR #268).
 *
 * Best-effort and rethrown unchanged for the same reason given there: a kill that failed
 * too would replace the collection failure with its own and send the caller after the
 * wrong call.
 */
async function collectOutput(process: HarnessProcess): Promise<RunResult> {
  let collected: [string, string, { exitCode: number }]
  try {
    collected = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.wait(),
    ])
  }
  catch (cause) {
    // {@link bestEffort} rather than `Promise.resolve(process.kill()).catch(…)`, which is
    // what this was: the harness types `kill()` as `PromiseLike<void>`, which has no
    // `.catch` and promises nothing about *when* the call fails, and the fragile spelling
    // evaluates it before any promise exists to catch a synchronous throw with.
    await bestEffort(() => process.kill())
    throw cause
  }
  const [stdout, stderr, exit] = collected
  return { exitCode: exit.exitCode, stdout, stderr }
}

export function createProcessSurface(options: ProcessSurfaceOptions): HarnessProcessSurface {
  async function spawn(processOptions: ProcessOptions): Promise<HarnessProcess> {
    const { handle, detach } = await startProcess(options, processOptions)
    const { abortSignal } = processOptions
    let events: ReadableStream<ProcessLogEvent>
    try {
      events = await openLogStream(handle, abortSignal)
    }
    catch (cause) {
      // The other exit that refuses a spawn, and it leaks the same listener the pre-check
      // does: the caller is handed a rejection and no process, while the signal keeps a
      // callback holding a handle nobody can reach. `once` cannot collect it on an aborted
      // signal — `abort` has fired — and on the unaborted branch it never fires at all.
      //
      // Rethrown untouched. {@link openLogStream} has already decided whether this caller
      // sees its own abort reason or the backend's cause, and re-deriving that here would be
      // a second copy of the decision, free to disagree with the first.
      detach()
      throw cause
    }
    const { stdout, stderr } = splitProcessStreams(events)
    return {
      // `pid` is optional and nothing here reads it. The contract exposes it only through
      // `status()`, so populating it would buy a round trip per spawn for a field no caller
      // asks for.
      stdout,
      stderr,
      wait: () => waitForProcessExit(handle, abortSignal),
      kill: () => handle.kill(),
    }
  }

  return {
    spawn,
    /** The harness's own note: spawn, collect both streams, await the exit. */
    run: async processOptions => collectOutput(await spawn(processOptions)),
  }
}

export interface SplitProcessStreams {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
}

type StreamSource = 'stdout' | 'stderr'

interface DemuxState {
  reader: ReadableStreamDefaultReader<ProcessLogEvent>
  sinks: Record<StreamSource, ReadableStreamDefaultController<Uint8Array> | undefined>
  /** Sources whose consumer cancelled. The reader is released once both have. */
  abandoned: Set<StreamSource>
  ended: boolean
}

/** Close both sinks, or error them, exactly once. */
function finishDemux(state: DemuxState, cause?: unknown): void {
  if (state.ended) {
    return
  }
  state.ended = true
  for (const sink of [state.sinks.stdout, state.sinks.stderr]) {
    if (cause === undefined) {
      sink?.close()
    }
    else {
      sink?.error(cause)
    }
  }
}

/**
 * Read the shared source until `wanted` sees a chunk, routing everything passed on the way.
 *
 * Draining only the source being pulled would hang a consumer that reads `stderr` to
 * completion before touching `stdout`: the events it needs would sit unread behind events
 * for the other stream. `terminal` and `truncated` events are dropped — the harness's
 * streams are bytes and have no representation for either, and the exit reaches the caller
 * through `wait()`.
 */
async function drainUntil(state: DemuxState, wanted: StreamSource): Promise<void> {
  for (;;) {
    if (state.ended) {
      return
    }
    let event: ProcessLogEvent
    try {
      const next = await state.reader.read()
      if (next.done) {
        finishDemux(state)
        return
      }
      event = next.value
    }
    catch (cause) {
      finishDemux(state, cause)
      throw cause
    }
    if (event.type !== 'stdout' && event.type !== 'stderr') {
      continue
    }
    state.sinks[event.type]?.enqueue(event.data)
    if (event.type === wanted) {
      return
    }
  }
}

/**
 * One tagged event stream into the two byte streams the harness expects.
 *
 * Both outputs read from a single reader, which is what {@link drainUntil} is shaped around.
 * A cancelled consumer drops its sink rather than releasing the reader, so the drain keeps
 * discarding that source's events for the other stream's benefit; only the second cancel
 * releases the shared source.
 */
export function splitProcessStreams(events: ReadableStream<ProcessLogEvent>): SplitProcessStreams {
  const state: DemuxState = {
    reader: events.getReader(),
    sinks: { stdout: undefined, stderr: undefined },
    abandoned: new Set(),
    ended: false,
  }

  const streamFor = (source: StreamSource): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>({
      start: (controller) => {
        state.sinks[source] = controller
      },
      pull: () => drainUntil(state, source),
      cancel: async () => {
        state.abandoned.add(source)
        state.sinks[source] = undefined
        if (state.abandoned.size === 2) {
          await state.reader.cancel().catch(() => {})
        }
      },
    })

  return { stdout: streamFor('stdout'), stderr: streamFor('stderr') }
}
