/**
 * An in-memory {@link SandboxProvider} for this package's tests.
 *
 * The provider is the only thing this package talks to, so faking it — rather than a
 * container, an e2b account, or `@cloudflare/sandbox` — exercises every line of the
 * translation with nothing else in the way. It records the *contract* calls each harness
 * call produced, because that is what the tests are about: the harness surface is a
 * translation, and a translation is only observable at the boundary it translates to.
 */
import type {
  ProcessExit,
  ProcessLogEvent,
  ProcessLogsOptions,
  ProcessStatus,
  SandboxCommand,
  SandboxExecOptions,
  SandboxFileContent,
  SandboxFileStream,
  SandboxPortEndpoint,
  SandboxPortEndpointOptions,
  SandboxProcessHandle,
  SandboxProvider,
  SandboxSession,
} from '@pleaseai/sandbox-contract'
import type { HarnessProcessSurface } from './process'
import { createProcessSurface } from './process'

export interface FakeReadCall {
  path: string
  encoding?: string
}

export interface FakeWriteCall {
  path: string
  content: string | ReadableStream<Uint8Array>
  encoding?: string
  /** Which sandbox the write was made against — the binding a derived view could lose. */
  sandboxId: string
}

export interface FakeExecCall {
  command: SandboxCommand
  options?: SandboxExecOptions
}

export interface FakeSandboxState {
  /**
   * Contents keyed by path, one map per sandbox id — seed it to make a file exist.
   *
   * Per sandbox rather than shared, and that is the substance rather than tidiness: with one
   * map, a surface that resolved the wrong id still finds the file and still reports it
   * `exists`, so every assertion in this package about reaching the sandbox a session is bound
   * to would hold over a misroute just as well as over a correct one (cubic review, PR #268).
   */
  files: (sandboxId: string) => Map<string, Uint8Array>
  reads: FakeReadCall[]
  writes: FakeWriteCall[]
  mkdirs: { path: string, recursive?: boolean }[]
  /**
   * Directory creations and writes in the order they were actually issued.
   *
   * Recorded separately because the per-call lists cannot answer an ordering question: a
   * surface that wrote first and created the parent afterwards produces the same `mkdirs` and
   * the same `writes` as one that got it right, and only fails against a real backend.
   */
  events: string[]
  execs: FakeExecCall[]
  /** How many times a spawned process was killed, across every process. */
  kills: number
  /** The options every `waitForExit` was handed — the signal a surface can silently drop. */
  waits: { signal?: AbortSignal }[]
  /** The options every `logs()` was handed — `replay` is the one a surface can silently drop. */
  logReads: (ProcessLogsOptions | undefined)[]
  /** How many log subscriptions were cancelled — the one a surface can silently leave open. */
  logCancels: number
  /** How many times the *contract's* `destroy()` was actually reached. */
  destroys: number
  portEndpoints: { sandboxId: string, port: number, protocol?: string }[]
  /** Every sandbox id `session()` was asked for, in order. */
  sessions: string[]
}

/** What a scripted process does: what it logs, and how it ends. */
export interface FakeProcessScript {
  events?: ProcessLogEvent[]
  exit?: ProcessExit
  /** Reject `waitForExit` instead of resolving — the abort and failure paths. */
  waitRejects?: unknown
  /** Reject `logs()` instead of resolving — a process that started and whose log never opened. */
  logsRejects?: unknown
  /**
   * Error the log stream *after* its scripted events, as a mid-run transport reset does.
   *
   * Distinct from {@link logsRejects}, which fails before any stream exists and so is caught
   * by `spawn`'s own guard. This one fails while the caller is already draining, which is
   * past that guard — the only way to reach the collection failure `run` has to survive.
   */
  eventsError?: unknown
  /**
   * Never open the subscription until the `logs()` call's own `signal` fires — a hung log-open.
   *
   * The shape the fifth startup window is measured in: `exec` has returned and the command is
   * running, and the subscription that would give the caller its output is still opening.
   */
  logsWaitsForAbort?: boolean
  /**
   * Settle only when the wait's own `signal` aborts, the way a real backend wait does.
   *
   * A script that rejects unconditionally cannot tell a surface that forwarded the signal from
   * one that dropped it: both reject, and an abort-reason assertion passes either way. This
   * one never settles unless the signal it was handed fires, so dropping it hangs.
   */
  waitsForAbort?: boolean
  /**
   * Throw *synchronously* out of `kill()` rather than rejecting — the shape a `.catch` misses.
   *
   * `Promise.resolve(handle.kill()).catch(…)` evaluates the argument first, so a throw from the
   * call itself happens before `Promise.resolve` is ever reached and escapes the handler
   * entirely. A rejecting `kill` cannot express that: it is caught by both spellings, so a
   * best-effort guard written the fragile way still passes (cubic review, PR #268).
   */
  killThrows?: unknown
}

export interface FakeSandboxOptions {
  backend?: string
  script?: (command: SandboxCommand) => FakeProcessScript
  /** How many leading `destroy()` calls reject before one succeeds — the transient-teardown path. */
  failingDestroys?: number
  /** Throw synchronously out of `destroy()` — see {@link FakeProcessScript.killThrows}. */
  destroyThrows?: unknown
  /**
   * Runs at the top of every `readFile`, before the path is looked up.
   *
   * The seam a read-time race is written through. `exists` and `readFile` are two calls, and a
   * hook that deletes the seeded file between them reproduces what a concurrent `rm` in the
   * sandbox does — which no amount of seeding can, because the fixture's two calls agree by
   * construction. A hook that throws models a read that failed for some other reason, with the
   * file still there.
   */
  beforeRead?: (path: string) => void
}

export function stdoutEvent(text: string): ProcessLogEvent {
  return { type: 'stdout', cursor: '0', timestamp: '', data: new TextEncoder().encode(text) }
}

export function stderrEvent(text: string): ProcessLogEvent {
  return { type: 'stderr', cursor: '0', timestamp: '', data: new TextEncoder().encode(text) }
}

export function exitedEvent(code: number): ProcessLogEvent {
  return { type: 'terminal', state: 'exited', cursor: '0', timestamp: '', exit: { code, timedOut: false } }
}

export function truncatedEvent(): ProcessLogEvent {
  return { type: 'truncated', timestamp: '' }
}

function decode(content: string, encoding?: string): Uint8Array {
  if (encoding === 'base64') {
    const binary = atob(content)
    return Uint8Array.from(binary, character => character.charCodeAt(0))
  }
  return new TextEncoder().encode(content)
}

function streamOf(
  chunks: readonly ProcessLogEvent[],
  error?: unknown,
  onCancel?: () => void,
): ReadableStream<ProcessLogEvent> {
  let index = 0
  return new ReadableStream<ProcessLogEvent>({
    cancel() {
      onCancel?.()
    },
    pull(controller) {
      if (index >= chunks.length) {
        if (error === undefined) {
          controller.close()
        }
        else {
          controller.error(error)
        }
        return
      }
      controller.enqueue(chunks[index++])
    },
  })
}

/**
 * A subscription that only settles when the `logs()` call's own `signal` fires.
 *
 * The `undefined` branch is why this is not simply a promise that never settles: a surface
 * that dropped the signal would then hang the suite on a timeout rather than fail on the
 * assertion that names the defect — the same reason {@link FakeProcessScript.waitsForAbort}
 * checks `aborted` before registering a listener.
 *
 * It rejects with a *backend-specific* message so a surface that forwards the signal but
 * hands the caller whatever the backend said, instead of the caller's own abort reason, is
 * visible too.
 */
function logsOnAbort(signal: AbortSignal | undefined): Promise<never> {
  if (signal === undefined) {
    return Promise.reject(new Error('log subscription opened without a signal'))
  }
  return new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new Error('backend-specific log failure'))
    if (signal.aborted) {
      fail()
      return
    }
    signal.addEventListener('abort', fail, { once: true })
  })
}

/**
 * A wait that only settles when the wait's own `signal` aborts, the way a real backend does.
 *
 * The sibling of {@link logsOnAbort}, one call earlier in a turn, and it rejects with its own
 * backend-specific message for the same reason: a surface that forwards the signal but hands
 * the caller whatever the backend said, instead of the caller's own abort reason, is visible.
 */
function waitOnAbort(signal: AbortSignal | undefined): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = (): void => reject(new Error('backend-specific wait failure'))
    // The check before the listener, not after it. `abort` is one-shot, so a listener
    // added to a signal that has already fired never runs, and a branch that only
    // registers one never settles for a caller who aborted between `spawn` and `wait` —
    // which is a real ordering, not a contrived one. A fixture that hangs there cannot
    // exercise the case the production code guards for twice over (`process.ts`); it
    // hangs the suite instead of failing it (cubic review, PR #268).
    if (signal?.aborted === true) {
      fail()
      return
    }
    signal?.addEventListener('abort', fail, { once: true })
  })
}

/** The scripted `logs()`, recording every options object a surface hands it. */
function fakeLogs(
  state: FakeSandboxState,
  script: FakeProcessScript,
): SandboxProcessHandle['logs'] {
  return (logOptions?: ProcessLogsOptions) => {
    state.logReads.push(logOptions)
    if (script.logsRejects !== undefined) {
      return Promise.reject(script.logsRejects)
    }
    if (script.logsWaitsForAbort === true) {
      return logsOnAbort(logOptions?.signal)
    }
    // A subscription is a live tail unless it asks for `replay` — the contract's own words
    // for the flag are "read the retained log from the beginning rather than from the live
    // tail". The scripted events are the *retained* log, all of it written before this call,
    // so a reader that omitted `replay` sees none of it. Answering them either way would let
    // a surface that drops the flag collect a full turn here and an empty one against a real
    // backend (cubic review, PR #268).
    const retained = logOptions?.replay === true ? script.events ?? [] : []
    return Promise.resolve(streamOf(retained, script.eventsError, () => {
      state.logCancels++
    }))
  }
}

/** The scripted `waitForExit()`, recording the signal a surface hands it. */
function fakeWaitForExit(
  state: FakeSandboxState,
  script: FakeProcessScript,
): SandboxProcessHandle['waitForExit'] {
  return (waitOptions?: { signal?: AbortSignal }) => {
    state.waits.push({ signal: waitOptions?.signal })
    if (script.waitRejects !== undefined) {
      return Promise.reject(script.waitRejects)
    }
    if (script.waitsForAbort === true) {
      return waitOnAbort(waitOptions?.signal)
    }
    return Promise.resolve(script.exit ?? { code: 0, timedOut: false })
  }
}

function fakeProcess(state: FakeSandboxState, id: string, script: FakeProcessScript): SandboxProcessHandle {
  return {
    id,
    status: (): Promise<ProcessStatus> => Promise.resolve({
      id,
      pid: 4242,
      command: ['sh'],
      startedAt: '',
      state: 'running',
    }),
    logs: fakeLogs(state, script),
    waitForExit: fakeWaitForExit(state, script),
    kill: () => {
      state.kills++
      if (script.killThrows !== undefined) {
        throw script.killThrows
      }
      return Promise.resolve()
    },
  }
}

/** A state record with every list empty — one call site, so a new field cannot be forgotten. */
function emptyState(): FakeSandboxState {
  const filesBySandbox = new Map<string, Map<string, Uint8Array>>()
  const filesFor = (sandboxId: string): Map<string, Uint8Array> => {
    const existing = filesBySandbox.get(sandboxId)
    if (existing) {
      return existing
    }
    const created = new Map<string, Uint8Array>()
    filesBySandbox.set(sandboxId, created)
    return created
  }
  return {
    files: filesFor,
    reads: [],
    writes: [],
    mkdirs: [],
    events: [],
    execs: [],
    kills: 0,
    waits: [],
    logReads: [],
    logCancels: 0,
    destroys: 0,
    portEndpoints: [],
    sessions: [],
  }
}

/**
 * The read half, which is the only one with a hook and two return shapes.
 *
 * `encoding: 'none'` answers a stream and everything else answers decoded text, so it carries
 * the cast the rest of the session does not need.
 */
function fakeReadFile(
  state: FakeSandboxState,
  options: FakeSandboxOptions,
  sandboxId: string,
): SandboxSession['readFile'] {
  return ((path: string, readOptions?: { encoding?: string }) => {
    state.reads.push({ path, encoding: readOptions?.encoding })
    try {
      options.beforeRead?.(path)
    }
    catch (cause) {
      // Rejected rather than thrown, because the contract's `readFile` returns a promise and
      // a caller's `try`/`catch` around an `await` is what is under test.
      return Promise.reject(cause)
    }
    const bytes = state.files(sandboxId).get(path)
    if (bytes === undefined) {
      return Promise.reject(new Error(`no such file: ${path}`))
    }
    if (readOptions?.encoding === 'none') {
      const stream: SandboxFileStream = {
        content: new ReadableStream<Uint8Array>({
          start(controller) {
            // Two chunks, always: a collector that returned only the first chunk would
            // still pass every single-chunk assertion.
            const midpoint = Math.ceil(bytes.length / 2)
            controller.enqueue(bytes.subarray(0, midpoint))
            controller.enqueue(bytes.subarray(midpoint))
            controller.close()
          },
        }),
      }
      return Promise.resolve(stream)
    }
    const content: SandboxFileContent = { content: new TextDecoder().decode(bytes), encoding: 'utf-8' }
    return Promise.resolve(content)
  }) as SandboxSession['readFile']
}

interface FakeSessionDeps {
  state: FakeSandboxState
  options: FakeSandboxOptions
  /** Recorded on every write, so a caller that resolved the wrong id is visible in `writes`. */
  sandboxId: string
  /** Provider-wide, so process ids stay unique across the sessions one provider hands out. */
  nextProcessId: () => string
}

/** The write, exec and lifecycle half — everything whose only output is a recorded call. */
function fakeSession(deps: FakeSessionDeps): SandboxSession {
  const { state, options, sandboxId } = deps
  return {
    readFile: fakeReadFile(state, options, sandboxId),
    writeFile: (path, content, writeOptions) => {
      state.writes.push({ path, content, encoding: writeOptions?.encoding, sandboxId })
      state.events.push(`write ${path}`)
      if (typeof content === 'string') {
        state.files(sandboxId).set(path, decode(content, writeOptions?.encoding))
        return Promise.resolve(undefined)
      }
      return new Response(content).arrayBuffer().then((buffer) => {
        state.files(sandboxId).set(path, new Uint8Array(buffer))
        return undefined
      })
    },
    mkdir: (path, mkdirOptions) => {
      state.mkdirs.push({ path, recursive: mkdirOptions?.recursive })
      state.events.push(`mkdir ${path}`)
      return Promise.resolve(undefined)
    },
    exec: (command, execOptions) => {
      state.execs.push({ command, options: execOptions })
      return Promise.resolve(fakeProcess(state, deps.nextProcessId(), options.script?.(command) ?? {}))
    },
    getProcess: () => Promise.resolve(null),
    listProcesses: () => Promise.resolve([]),
    exists: path => Promise.resolve({ exists: state.files(sandboxId).has(path) }),
    destroy: () => {
      state.destroys++
      if (options.destroyThrows !== undefined) {
        throw options.destroyThrows
      }
      if (state.destroys <= (options.failingDestroys ?? 0)) {
        return Promise.reject(new Error('destroy failed'))
      }
      return Promise.resolve()
    },
  }
}

export function fakeSandboxProvider(
  options: FakeSandboxOptions = {},
): { provider: SandboxProvider, state: FakeSandboxState } {
  const state = emptyState()
  let processes = 0
  const nextProcessId = (): string => `proc-${++processes}`

  // One session object per id, so a caller that resolved the wrong id reaches a different
  // sandbox rather than the same one under another name — which is the regression a single
  // shared session cannot express.
  const sessions = new Map<string, SandboxSession>()

  const provider: SandboxProvider = {
    backend: options.backend ?? 'fake',
    session: (sandboxId) => {
      state.sessions.push(sandboxId)
      const existing = sessions.get(sandboxId)
      if (existing) {
        return existing
      }
      const created = fakeSession({ state, options, sandboxId, nextProcessId })
      sessions.set(sandboxId, created)
      return created
    },
    portEndpoint: (
      sandboxId: string,
      port: number,
      endpointOptions?: SandboxPortEndpointOptions,
    ): Promise<SandboxPortEndpoint> => {
      state.portEndpoints.push({ sandboxId, port, protocol: endpointOptions?.protocol })
      return Promise.resolve({
        url: `${endpointOptions?.protocol ?? 'http'}://${sandboxId}.example/${String(port)}`,
        headers: { 'x-fake': sandboxId },
      })
    },
  }

  return { provider, state }
}

/** Where a fixture process surface runs a command the caller named no directory for. */
export const FIXTURE_CWD = '/workspace'

/**
 * A process surface over a fresh fake sandbox, and the state its contract calls land in.
 *
 * Shared by both process suites — the behaviour one and the cleanup-guard one — so the
 * wiring is written once rather than copied into each.
 */
export function processSurface(
  script?: FakeSandboxOptions['script'],
): { surface: HarnessProcessSurface, state: FakeSandboxState } {
  const { provider, state } = fakeSandboxProvider({ script })
  return {
    surface: createProcessSurface({ sandbox: provider.session('sbx'), defaultWorkingDirectory: FIXTURE_CWD }),
    state,
  }
}
