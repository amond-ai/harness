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
  /**
   * Signal the process. Without `signal` the backend sends whatever it terminates with
   * (`@cloudflare/sandbox`: SIGTERM; the e2b backend: a SIGKILL walk of the tree). `2` (SIGINT)
   * asks the process to finish on its own terms instead: the `claude` CLI answers it by ending
   * the turn and printing its `result`, which SIGTERM never yields. A backend that cannot
   * deliver a named signal must neither do nothing silently nor substitute a harsher one — a
   * SIGKILL sent where SIGINT was asked for ends the turn without the `result` the interrupt
   * exists to collect. It reports the non-delivery (a log the sandbox surfaces is enough) and
   * leaves the caller's bounded wait to time out and escalate to the default kill.
   */
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
/**
 * Encodings the file surface accepts. `'none'` is not here: it selects the streaming
 * overload of {@link SandboxFiles.readFile} rather than an encoding of the returned text.
 */
export type SandboxFileEncoding = 'utf-8' | 'utf8' | 'base64'

/**
 * A streamed read — `readFile(path, { encoding: 'none' })`.
 *
 * Carries the stream and nothing else. Cloudflare's own result also reports `size`, but a
 * backend that streams without knowing the length up front would have to read the whole file
 * to answer, and no caller asks — so requiring it would bill every backend for a number
 * nobody reads.
 */
export interface SandboxFileStream {
  content: ReadableStream<Uint8Array>
}

/** A decoded read. `encoding` reports what the backend chose when the caller did not. */
export interface SandboxFileContent {
  content: string
  encoding?: 'utf-8' | 'base64'
}

/**
 * Reading and writing files in the sandbox.
 *
 * Split out because it arrived for one caller — the AI SDK harness session, whose
 * `SandboxSession` requires full file I/O — and the contract's own note says to widen only
 * when a caller appears. It is declared in *Cloudflare's* shape (positional path,
 * encoding-selected overloads) rather than the harness's (options objects, three read
 * variants), which keeps the property this package is built on: `@cloudflare/sandbox`'s
 * client satisfies the contract with no mapping layer, and a non-Cloudflare backend pays
 * the mapping cost. The harness's own shape is a further translation, and it belongs in the
 * harness provider — written once, over the contract, for every backend at once.
 */
export interface SandboxFiles {
  /** Rejects when the path does not exist; callers wanting absence-as-value pair it with `exists`. */
  readFile: ((path: string, options: { encoding: 'none' }) => Promise<SandboxFileStream>)
    & ((path: string, options?: { encoding?: SandboxFileEncoding }) => Promise<SandboxFileContent>)
  writeFile: (
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: SandboxFileEncoding },
  ) => Promise<unknown>
  mkdir: (path: string, options?: { recursive?: boolean }) => Promise<unknown>
}

/**
 * Where a port inside the sandbox can be reached, and what to send when dialing it.
 *
 * Structurally `HarnessV1PortEndpoint`, because the AI SDK harness is the caller that made
 * this surface necessary and its adapter consumes exactly this shape: it asks for
 * `{ url, headers }` and constructs the socket itself. That is also why this is a *data*
 * shape and not a `connectPort()` handing back a socket — a dial method would have no
 * caller, and the rule this contract states about itself is to declare only what is used.
 *
 * **The URL is not promised to be publicly routable.** It is promised to be dialable by the
 * runtime the orchestrator runs in, which is both weaker and more useful. e2b answers with a
 * real public host (`https://<port>-<id>.e2b.app`); a Cloudflare sandbox has no such address
 * a Worker should use, because its bridge port is private and the Worker reaches it by asking
 * the Durable Object to open the socket (`wsConnect`) rather than by resolving a name. So the
 * Cloudflare backend answers with a URL tagged for its own transport, which
 * `@amond-ai/harness-transport-cloudflare` recognises and dials through the binding, while an
 * untagged URL is dialed directly. Which of the two a backend mints is the backend's
 * business, and no caller has to know.
 */
export interface SandboxPortEndpoint {
  readonly url: string
  readonly headers?: Readonly<Record<string, string>>
}

export interface SandboxPortEndpointOptions {
  /** Scheme the caller intends to speak over the port. */
  protocol?: 'http' | 'https' | 'ws' | 'wss'
}

export interface SandboxSession extends SandboxFiles {
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
  /**
   * How to reach `port` inside the sandbox named by `sandboxId`.
   *
   * On the *provider* rather than the session, and deliberately. `SandboxSession` is
   * satisfied by `@cloudflare/sandbox`'s own client with no mapping layer at all — that is
   * the property this whole package is built on — and one added method would end it, because
   * the vendor object has no `portEndpoint` and never will: the tagging described on
   * {@link SandboxPortEndpoint} is this repo's protocol, not Cloudflare's. A provider, by
   * contrast, is written here for every backend, so it is where a shape nobody upstream
   * implements belongs.
   *
   * Required rather than optional: a backend that cannot say where its ports are cannot run
   * the harness at all, and finding that out at the first connect — inside a workflow step —
   * is strictly worse than finding it out at build time.
   */
  portEndpoint: (
    sandboxId: string,
    port: number,
    options?: SandboxPortEndpointOptions,
  ) => Promise<SandboxPortEndpoint>
}
