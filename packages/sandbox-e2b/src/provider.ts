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
import type {
  SandboxPortEndpoint,
  SandboxPortEndpointOptions,
  SandboxProvider,
  SandboxSession,
} from '@pleaseai/sandbox-contract'
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
/**
 * The scheme a caller that named none gets.
 *
 * `https`, not `http`: e2b terminates TLS at its own edge and an e2b port is reached over
 * the public internet, so the plaintext reading would be the wrong default here even though
 * it is the right one for a port that never leaves a container.
 */
const DEFAULT_PROTOCOL = 'https'

/**
 * The scheme actually spoken for each one a caller can name — same kind, always over TLS.
 *
 * This is a provider overriding an explicit request, which needs justifying rather than
 * noting. Measured against a real sandbox from inside workerd on 2026-08-25, and pinned in
 * `apps/cf-orchestrator/test/workerd-spike/e2b-bridge-socket.test.ts`:
 *
 * ```
 * http://<port>-<id>.e2b.app/   → Error: Network connection lost.      (with or without `Upgrade`)
 * https://<port>-<id>.e2b.app/  → the origin's own answer               (no `Upgrade`)
 * https://<port>-<id>.e2b.app/  → 101 Switching Protocols + webSocket  (with `Upgrade`)
 * ```
 *
 * A plaintext e2b port endpoint does not exist: nothing listens on port 80, so honouring
 * `'http'` or `'ws'` literally can only hand back a URL that provably cannot be dialed. The
 * alternative to upgrading is therefore not a stricter answer, it is a dead one — refusing
 * `'ws'` outright would fail the very caller this backend exists to serve, since
 * `@ai-sdk/harness-claude-code` asks for `getPortEndpoint({ port, protocol: 'ws' })` and
 * nothing else, and it is not ours to patch (a wrangler `alias` is why, see
 * `@pleaseai/harness-cf-transport`).
 *
 * It is the same fact {@link DEFAULT_PROTOCOL} already reasons from — e2b terminates TLS at
 * its own edge — carried from the default to the explicit case. The *kind* is preserved,
 * because that is the part the caller actually knows and this provider does not: `ws`→`wss`
 * is a socket either way, `http`→`https` is a request either way.
 *
 * Deliberately not fixed in the transport: `direct-connect.ts`'s `ws:`→`http:` mapping is
 * correct for a backend whose port really is plaintext — a container-internal bridge, a local
 * one — and hard-wiring TLS there would break those to fix this.
 */
const TLS_SCHEME: Record<NonNullable<SandboxPortEndpointOptions['protocol']>, 'https' | 'wss'> = {
  http: 'https',
  https: 'https',
  ws: 'wss',
  wss: 'wss',
}

export function createE2bProvider(options: E2bProviderOptions): SandboxProvider {
  const template = options.template ?? DEFAULT_TEMPLATE
  const journalRoot = options.journalRoot ?? DEFAULT_JOURNAL_ROOT

  /** The sandbox e2b already holds for this id, without minting one that is not there. */
  async function connect(sandboxId: string): Promise<E2bSandboxLike | undefined> {
    const existing = await options.api.list({ [SANDBOX_ID_METADATA_KEY]: sandboxId })
    const found = existing[0]
    return found ? options.api.connect(found.sandboxId) : undefined
  }

  async function listThenCreate(sandboxId: string): Promise<E2bSandboxLike> {
    return await connect(sandboxId) ?? options.api.create(template, {
      metadata: { [SANDBOX_ID_METADATA_KEY]: sandboxId },
      envs: options.envs,
      timeoutMs: options.timeoutMs,
    })
  }

  /** Acquisitions currently in flight, one per sandbox id. */
  const acquiring = new Map<string, Promise<E2bSandboxLike>>()

  /**
   * The list-then-create walk, shared by everyone who starts it at the same time.
   *
   * `lazySession` already memoises, but only per session object, and it memoises the
   * *session* — `portEndpoint` needs the `E2bSandboxLike` underneath it, which a
   * `SandboxSession` has no way to hand back, so it reaches here directly. Two first calls in
   * flight at once therefore both `list`, both find nothing, and both `create`: two sandboxes
   * for one id, one of them orphaned with nothing left holding a handle to kill it.
   *
   * Shared while in flight and no longer: a settled acquisition is deliberately not memoised
   * here. `portEndpoint` is documented as costing a round trip, and a provider-level memo
   * would also outlive a `destroy()` and hand back a dead sandbox. Once the walk has settled
   * the sandbox is listable, so the next caller reattaches instead of creating.
   */
  function acquire(sandboxId: string): Promise<E2bSandboxLike> {
    const inFlight = acquiring.get(sandboxId)
    if (inFlight) {
      return inFlight
    }
    const started = listThenCreate(sandboxId).finally(() => acquiring.delete(sandboxId))
    acquiring.set(sandboxId, started)
    return started
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
    /**
     * A real, publicly routable address — which is why it costs a round trip.
     *
     * The id in hand is the orchestrator's and e2b has never heard of it (see the header), so
     * the host cannot be formatted from it: only the sandbox e2b actually holds knows what it
     * was assigned, and reaching that sandbox is the same list-then-connect walk every other
     * call makes. `getHost` itself is local once the sandbox is resolved.
     */
    portEndpoint: async (
      sandboxId: string,
      port: number,
      endpointOptions?: SandboxPortEndpointOptions,
    ): Promise<SandboxPortEndpoint> => {
      const sandbox = await acquire(sandboxId)
      // Never the scheme as asked when it is a plaintext one — {@link TLS_SCHEME} carries why.
      const protocol = TLS_SCHEME[endpointOptions?.protocol ?? DEFAULT_PROTOCOL]
      return { url: new URL(`${protocol}://${sandbox.getHost(port)}`).toString() }
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
    // The file surface allocates on first use like every other call: a read is a use of the
    // sandbox, so it acquires one, rather than being answered against a session that is not
    // there yet.
    readFile: (async (path: string, fileOptions?: { encoding?: string }) =>
      (await resolved()).readFile(path, fileOptions as { encoding: 'none' })) as SandboxSession['readFile'],
    writeFile: async (path, content, fileOptions) =>
      (await resolved()).writeFile(path, content, fileOptions),
    mkdir: async (path, mkdirOptions) => (await resolved()).mkdir(path, mkdirOptions),
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
