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
 * **Waking.** The contract makes a reattached sandbox *usable* the backend's obligation
 * (`SandboxProvider` in `@amond-ai/sandbox`), and on e2b that obligation is met by the
 * connect itself: `Sandbox.connect()` is `POST /sandboxes/{id}/connect`, whose contract reads
 * "if the sandbox is paused, it will be resumed" (e2b 2.45.0, `SandboxApi.connect` and the
 * OpenAPI description), and it answers once the resume is done — research note 027 Q5 read a
 * file through exactly that path. So there is no `start()` here the way the Daytona backend
 * has one, and nothing to wait for after `connect` resolves. The flip side is that connecting
 * *is* waking: a paused sandbox cannot be inspected without resuming it, which is why
 * discovery below avoids the walk entirely when `list` finds nothing and pays the resume only
 * when it finds a paused one, and why release goes through `Sandbox.kill(sandboxId)` — a
 * `DELETE` by id — rather than a connect. Left to the API default (`onTimeout: 'kill'`) a
 * sandbox that outlives `timeoutMs` is not paused but gone — `list` no longer returns it and
 * the next step creates afresh — so the paused case is the one a deployment opts into.
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
} from '@amond-ai/sandbox'
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
  /**
   * `Sandbox.kill(sandboxId)` — a `DELETE` by id, which is how a sandbox nobody holds a handle
   * to is released without `connect` resuming it first (see the header).
   */
  kill: (sandboxId: string) => Promise<boolean>
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
 * `@amond-ai/harness-transport-cloudflare`).
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

  /** The e2b-side id for this session id, from `list`, without minting one that is not there. */
  async function findExisting(sandboxId: string): Promise<string | undefined> {
    const existing = await options.api.list({ [SANDBOX_ID_METADATA_KEY]: sandboxId })
    return existing[0]?.sandboxId
  }

  /** The sandbox e2b already holds for this id, without minting one that is not there. */
  async function connect(sandboxId: string): Promise<E2bSandboxLike | undefined> {
    const found = await findExisting(sandboxId)
    return found ? options.api.connect(found) : undefined
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
        followIntervalMs: options.followIntervalMs,
        followLivenessIntervalMs: options.followLivenessIntervalMs,
      }
      const created = lazySession({
        open: async () => createE2bSession(await acquire(sandboxId), sessionOptions),
        openExisting: async () => {
          const sandbox = await connect(sandboxId)
          return sandbox && createE2bSession(sandbox, sessionOptions)
        },
        release: async () => {
          const found = await findExisting(sandboxId)
          if (found) {
            await options.api.kill(found)
          }
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
  /** Kill the sandbox for this id by id, without connecting; a no-op when e2b holds none. */
  release: () => Promise<void>
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
  /**
   * The session for a sandbox that already exists, or `undefined` — never the thing that makes one.
   *
   * An acquisition already in flight is reused, so a caller that follows `exec` pays nothing here;
   * otherwise this connects without creating, exactly as `destroy` has always done.
   */
  const existing = async (): Promise<SandboxSession | undefined> =>
    pending ? await pending : await options.openExisting()

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
    /**
     * Discovery, which the contract says must not create anything.
     *
     * `packages/amond-ai/sandbox/src/types.ts` names `getProcess`/`listProcesses` non-waking discovery
     * that answers from cold state, and gives `exists` the job of booting — so routing these
     * two through the acquisition broke the contract on this backend: recovery asking whether
     * a stale turn is still there (`replay-turn.ts`) would *create* a billable sandbox merely
     * to be told `null`, the same shape the Daytona backend fixed in PR #463 (#464).
     *
     * "No sandbox" is an answer here rather than an error: nothing can be running in a sandbox
     * that does not exist, which is precisely what `null`/`[]` say. A sandbox e2b still holds
     * is read — and on e2b that read resumes a paused one, because `connect` is the only way
     * to reach its process table (see the header); the cost avoided here is the create.
     */
    getProcess: async (id) => {
      const session = await existing()
      return session ? await session.getProcess(id) : null
    },
    listProcesses: async () => {
      const session = await existing()
      return session ? await session.listProcesses() : []
    },
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
     *
     * And on e2b, not even connecting: `connect` resumes a paused sandbox (see the header),
     * so reaching one through `openExisting` to kill it would pay for a boot whose only use is
     * being deleted. `Sandbox.kill(sandboxId)` deletes by id in whatever state the sandbox
     * rests, so a session that never acquired releases through that. One that did already
     * holds the running sandbox, and kills it through the session as before.
     */
    destroy: async () => {
      if (pending) {
        await (await pending).destroy()
        return
      }
      await options.release()
    },
  }
}
