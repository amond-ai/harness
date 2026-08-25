/**
 * The sandbox surface the orchestrator actually runs against.
 *
 * These types are *structural copies* of the `@cloudflare/sandbox` shapes, not imports of
 * them, and that is the whole point of the package. Importing them would make every future
 * backend — e2b, Daytona, a local container — depend on the Cloudflare SDK to describe a
 * process it never runs there. Copying them keeps the contract free of any one vendor while
 * staying structurally assignable from the Cloudflare types, so `@cloudflare/sandbox`'s own
 * `ISandbox` satisfies {@link SandboxSession} with no mapping layer at all (see
 * `sandbox-cloudflare.ts`). A non-Cloudflare backend pays the mapping cost; the incumbent
 * pays nothing.
 *
 * The surface is deliberately the *used* one, not the full one. `ISandbox` carries ~20
 * methods and `SandboxProcess` nine; the orchestrator calls ten of them between the two.
 * Everything omitted here — `writeFile`, `mkdir`, `createTerminal`, `waitForPort`,
 * `output`, `waitForLog` — is absent because no caller in `apps/cf-orchestrator/src/run`
 * reaches for it, and a contract that declares unused methods bills every backend for
 * implementing them. Widen it when a caller appears, not before.
 *
 * One asymmetry is worth stating, because it is why this contract exists rather than
 * `Experimental_SandboxSession` from `@ai-sdk/provider-utils`: the AI SDK's sandbox session
 * has no process-reattachment primitive. Its `SandboxProcess` hands back live `stdout` and
 * `stderr` streams and an optional `pid`, and nothing that resolves a process id back into a
 * handle. The run workflow's durability is built on exactly that — `getProcess(id)` plus
 * `logs({ replay: true })` is how a retried step re-reads a turn's output from the
 * beginning (AC-015). A contract without it cannot express what this orchestrator already
 * does, so the AI SDK shape is a peer of this one, not its parent.
 */

/** Argv, never a shell string: the no-quoting policy in `claude-argv.ts` depends on it. */
export type SandboxCommand = readonly [executable: string, ...args: string[]]

export interface SandboxExecOptions {
  cwd?: string
  env?: Record<string, string>
  timeout?: number
}

/** Terminal outcome of a process's supervised group. */
export interface ProcessExit {
  code: number
  signal?: number
  timedOut: boolean
}

export interface ProcessFailure {
  code: string
  message: string
}

interface ProcessStatusBase {
  id: string
  pid: number
  command: SandboxCommand
  cwd?: string
  startedAt: string
}

/** Lifecycle state for the complete supervised process group. */
export type ProcessStatus
  = | (ProcessStatusBase & { state: 'running' })
    | (ProcessStatusBase & { state: 'exited', exit: ProcessExit, endedAt: string })
    | (ProcessStatusBase & { state: 'error', error: ProcessFailure, endedAt: string })

/**
 * Opaque position in a process's log. Carried across calls so a follow-up read resumes
 * where the last one stopped instead of replaying what the caller already folded in.
 */
export type ProcessLogCursor = string

export type ProcessLogEvent
  = | { type: 'stdout' | 'stderr', cursor: ProcessLogCursor, timestamp: string, data: Uint8Array }
    | { type: 'terminal', state: 'exited', cursor: ProcessLogCursor, timestamp: string, exit: ProcessExit }
    | { type: 'terminal', state: 'error', cursor: ProcessLogCursor, timestamp: string, error: ProcessFailure }
    | { type: 'truncated', cursor?: ProcessLogCursor, timestamp: string }

export interface ProcessLogsOptions {
  since?: ProcessLogCursor
  /** Read the retained log from the beginning rather than from the live tail. */
  replay?: boolean
  follow?: boolean
  signal?: AbortSignal
}

/**
 * Bounds on a wait — never on the process.
 *
 * A wait that ends before the process does **rejects**; it never resolves. That is not a
 * stylistic preference, it is what every caller is already written against: in
 * `run-workflow.ts` the `catch` around `waitForExit` *is* the timeout path — `killTurn`
 * treats it as "the kill was not confirmed", `materializationExit` as "kill the clone and
 * fail the step". A backend that resolves instead silently converts "I stopped watching"
 * into "it is dead", and the caller then proceeds over a process that is still running:
 * a clone racing the retry over the same tree, or a second `claude` turn on the same repo.
 *
 * So a resolved {@link ProcessExit} always describes a process that actually exited, and
 * `timedOut` on it means the *process* was killed by its own timeout — not that the caller
 * gave up. `@cloudflare/sandbox` already behaves this way (`ProcessWaitTimeoutError`); a
 * rejection carrying {@link SandboxWaitTimeoutError} is this contract's spelling of it, so
 * a caller can tell an expired wait from an arbitrary transport failure.
 *
 * `timeout` is what makes a wait expirable, and a backend may not invent one:
 *
 * - **with `timeout`** — the wait rejects with {@link SandboxWaitTimeoutError} once the
 *   budget elapses;
 * - **without `timeout`** — the wait does not expire, and
 *   {@link SandboxWaitTimeoutError} is unreachable. It may still reject for a reason the
 *   backend actually observed, such as finding the process gone with no exit recorded.
 *
 * That second case is a property callers rely on, not a gap left to each backend's taste:
 * `awaitTurn` in `run-workflow.ts` races an unbounded `waitForExit()` inside a step that
 * allows a live turn six hours and is never retried, so a private cap in one backend does
 * not bound a wait — it fails the run for a turn that was merely long.
 */
export interface WaitForExitOptions {
  timeout?: number
  signal?: AbortSignal
}

/**
 * The wait ended before the process did.
 *
 * The one runtime value this package exports, deliberately: a caller that must distinguish
 * "still running, I stopped watching" from "the RPC failed" needs a shared identity to test
 * against, and a string-matched message is not one.
 */
/**
 * The two ways a wait can end without an exit — kept apart because they ask the caller for
 * opposite things.
 *
 * {@link SandboxWaitTimeoutError}: the wait ended, the process did not. It may well still be
 * running, so the caller kills it or waits longer.
 * {@link SandboxNoExitRecordError}: the process is already gone and recorded no exit. Waiting
 * again buys nothing; the caller reports the failure.
 *
 * **They are not an exhaustive union, and a caller must keep a fallback branch.** A backend
 * SHOULD raise these where they apply, but a wait can reject for reasons neither type covers —
 * `@cloudflare/sandbox` throws its own `ProcessWaitTimeoutError`, which is a genuine timeout
 * this contract has no view of, and any transport can fail. Code that treats the two as the
 * whole space mislabels the third kind rather than reporting it.
 */
export class SandboxWaitTimeoutError extends Error {
  /** The process still running when the wait gave up. */
  readonly processId: string
  /** The budget that elapsed, in milliseconds — not the process's own runtime. */
  readonly elapsedMs: number

  constructor(processId: string, elapsedMs: number) {
    super(`wait for process '${processId}' ended after ${elapsedMs}ms; the process is still running`)
    this.name = 'SandboxWaitTimeoutError'
    this.processId = processId
    this.elapsedMs = elapsedMs
  }
}

/** A wait that ended because the process vanished without journalling an exit code. */
export class SandboxNoExitRecordError extends Error {
  /** The process found gone with nothing recorded. */
  readonly processId: string

  constructor(processId: string) {
    super(`process '${processId}' is no longer running and journalled no exit code`)
    this.name = 'SandboxNoExitRecordError'
    this.processId = processId
  }
}

/**
 * A process that outlives the call that started it.
 *
 * The backend must retain the log for as long as the sandbox lives, because
 * {@link SandboxProcessHandle.logs} with `replay: true` is read *after* the process has
 * exited — a turn is parsed only once its exit is known.
 */
export interface SandboxProcessHandle {
  readonly id: string
  status: () => Promise<ProcessStatus>
  logs: (options?: ProcessLogsOptions) => Promise<ReadableStream<ProcessLogEvent>>
  /**
   * Resolves only once the process has actually exited; rejects otherwise.
   *
   * A wait bounded by {@link WaitForExitOptions.timeout} or aborted by its `signal` rejects
   * with {@link SandboxWaitTimeoutError} rather than resolving a synthetic exit — see
   * {@link WaitForExitOptions} for why the caller's `catch` is load-bearing here.
   */
  waitForExit: (options?: WaitForExitOptions) => Promise<ProcessExit>
  kill: (signal?: number) => Promise<void>
}

/**
 * One sandbox, addressed by the id its provider was asked for.
 *
 * `exists` is on the contract for a reason that is not filesystem access: it is the call
 * that *boots* the container. `listProcesses`/`getProcess` are documented as non-waking
 * discovery calls that answer from cold state, so a backend that needs warming must do it
 * through a request that reaches the container server.
 */
export interface SandboxSession {
  exec: (command: SandboxCommand, options?: SandboxExecOptions) => Promise<SandboxProcessHandle>
  getProcess: (id: string) => Promise<SandboxProcessHandle | null>
  listProcesses: () => Promise<ProcessStatus[]>
  exists: (path: string) => Promise<{ exists: boolean }>
  destroy: () => Promise<void>
}

/**
 * Resolves a sandbox id to a session.
 *
 * Resolution is synchronous and cheap by contract: the orchestrator calls it per use rather
 * than holding a session across a workflow step, because a Durable Object stub does not
 * survive a step boundary. A backend whose handle acquisition is genuinely async should do
 * that work lazily inside the returned session's first call.
 */
export interface SandboxProvider {
  readonly backend: string
  session: (sandboxId: string) => SandboxSession
}
