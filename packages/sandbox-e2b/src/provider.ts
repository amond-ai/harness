/**
 * `SandboxProvider` over e2b, and the two things that need reconciling to get there.
 *
 * **Identity.** The contract addresses a sandbox by the id the orchestrator chose
 * (`sandboxIdForRun(runId)`); e2b mints its own. So a session's id is written into e2b
 * `metadata` at create time and looked up through `Sandbox.list({ query: { metadata } })`,
 * whose default state filter covers paused sandboxes as well as running ones — a retried
 * workflow step must reach the sandbox its predecessor left behind, whatever state e2b put
 * it in.
 *
 * **Timing.** `SandboxProvider.session` is synchronous by contract, because the Cloudflare
 * backend resolves a Durable Object stub with no I/O and callers hold a session for one
 * step at a time. Acquiring an e2b sandbox is a network call, so it is deferred to the
 * session's first use and memoised: `session(id)` on its own costs nothing, and a step that
 * makes five calls creates one sandbox.
 */
import type { SandboxProvider, SandboxSession } from '@pleaseai/sandbox-contract'
import type { E2bSandboxLike, E2bSessionOptions } from './e2b-session'
import { createE2bSession } from './e2b-session'

/** The `Sandbox` statics this provider needs, structural so tests can stand in for them. */
export interface E2bSandboxApi {
  create: (
    template: string,
    opts: { metadata?: Record<string, string>, envs?: Record<string, string>, timeoutMs?: number },
  ) => Promise<E2bSandboxLike>
  connect: (sandboxId: string) => Promise<E2bSandboxLike>
  list: (query: { pleaseSandboxId?: string }) => Promise<{ sandboxId: string }[]>
}

export interface E2bProviderOptions extends Partial<Omit<E2bSessionOptions, 'journalRoot'>> {
  api: E2bSandboxApi
  /** e2b template. Defaults to `claude`, the prebuilt image that ships the CLI. */
  template?: string
  /** Directory the process journal lives in, inside the sandbox. */
  journalRoot?: string
  /** Environment baked into the sandbox — model credentials, git identity. */
  envs?: Record<string, string>
  /**
   * Sandbox lifetime. Also re-applied while a wait is in flight (`sandbox.setTimeout`), so
   * a turn that outlives it keeps its sandbox instead of being stopped under itself.
   */
  timeoutMs?: number
}

/** e2b's prebuilt Claude Code image: ships `claude`, invoked as `-p --output-format stream-json`. */
const DEFAULT_TEMPLATE = 'claude'
const DEFAULT_JOURNAL_ROOT = '/home/user/.agent-runs'
/** The metadata key carrying the orchestrator's own sandbox id. */
export const SANDBOX_ID_METADATA_KEY = 'pleaseSandboxId'

export function createE2bProvider(options: E2bProviderOptions): SandboxProvider {
  const template = options.template ?? DEFAULT_TEMPLATE
  const journalRoot = options.journalRoot ?? DEFAULT_JOURNAL_ROOT

  /** The sandbox e2b already holds for this id, without minting one that is not there. */
  async function connect(sandboxId: string): Promise<E2bSandboxLike | undefined> {
    const existing = await options.api.list({ [SANDBOX_ID_METADATA_KEY]: sandboxId })
    const found = existing[0]
    return found ? options.api.connect(found.sandboxId) : undefined
  }

  async function acquire(sandboxId: string): Promise<E2bSandboxLike> {
    return await connect(sandboxId) ?? options.api.create(template, {
      metadata: { [SANDBOX_ID_METADATA_KEY]: sandboxId },
      envs: options.envs,
      timeoutMs: options.timeoutMs,
    })
  }

  /**
   * One session per sandbox id, for this provider's lifetime.
   *
   * The run workflow calls `this.sandbox(id)` afresh in every step, so without this a
   * single run would list-and-connect on each of them. The Cloudflare backend can hand
   * back a new stub each time because that costs no I/O; here it costs a round trip.
   */
  const sessions = new Map<string, SandboxSession>()

  return {
    backend: 'e2b',
    session: (sandboxId: string) => {
      const cached = sessions.get(sandboxId)
      if (cached) {
        return cached
      }
      const sessionOptions = {
        journalRoot,
        newProcessId: options.newProcessId,
        now: options.now,
        pollIntervalMs: options.pollIntervalMs,
        monotonicNowMs: options.monotonicNowMs,
        sandboxTimeoutMs: options.timeoutMs,
        commandTimeoutMs: options.commandTimeoutMs,
      }
      const created = lazySession({
        open: async () => createE2bSession(await acquire(sandboxId), sessionOptions),
        openExisting: async () => {
          const sandbox = await connect(sandboxId)
          return sandbox && createE2bSession(sandbox, sessionOptions)
        },
      })
      sessions.set(sandboxId, created)
      return created
    },
  }
}

interface LazySessionOptions {
  /** Connect to the sandbox for this id, creating one when e2b holds none. */
  open: () => Promise<SandboxSession>
  /** Connect only — resolves `undefined` rather than creating one. */
  openExisting: () => Promise<SandboxSession | undefined>
}

/**
 * A session whose backing sandbox is acquired on first use and reused after.
 *
 * The promise is memoised rather than the resolved session so concurrent first calls share
 * one acquisition instead of racing to create two sandboxes for the same id.
 */
function lazySession(options: LazySessionOptions): SandboxSession {
  let pending: Promise<SandboxSession> | undefined
  const resolved = (): Promise<SandboxSession> => (pending ??= options.open().catch((cause: unknown) => {
    // Memoise the acquisition, not its failure. A rejected promise left in `pending` is
    // rethrown by every later call without touching e2b again, so one transient `list` or
    // `create` error would outlive itself and `PREPARE_RETRIES` could never recover from it
    // — the retry would replay the original rejection instead of retrying (codex review,
    // PR #260). Cleared on rejection only, so concurrent callers still share one in-flight
    // acquisition.
    pending = undefined
    throw cause
  }))
  return {
    exec: async (command, execOptions) => (await resolved()).exec(command, execOptions),
    getProcess: async id => (await resolved()).getProcess(id),
    listProcesses: async () => (await resolved()).listProcesses(),
    exists: async path => (await resolved()).exists(path),
    /**
     * Release, which must never be the thing that allocates.
     *
     * `RunAgent.settle()` calls `releaseSandbox()` in a `finally`, so it also runs for a run
     * that was refused before it ever touched a sandbox — and it runs on a *different*
     * instance from the workflow that started the turn, so "this provider never acquired the
     * session" does not mean "no sandbox exists". Going through `open()` would therefore
     * create a sandbox purely to kill it, while skipping the call whenever the session was
     * never acquired would leak every sandbox the workflow made. Connecting without creating
     * is the reading that is right in both directions (codex review, PR #260).
     */
    destroy: async () => {
      const session = pending ? await pending : await options.openExisting()
      await session?.destroy()
    },
  }
}
