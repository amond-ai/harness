/**
 * `SandboxProvider` over `@vercel/sandbox`, and the three things that need reconciling to get
 * there.
 *
 * **Identity is a name, and names are not free-form.** The contract addresses a sandbox by the id
 * the orchestrator chose (`sandboxIdForRun(runId)`), and Vercel has no metadata, labels or tags to
 * look one up by — `name` *is* the identity, and it lands in a URL path and in the subdomain a
 * routed port is reached through. So the mapping from id to name has to be injective, and a lossy
 * normalisation is exactly how two runs come to share one sandbox. This provider refuses rather
 * than normalises; see {@link sandboxNameFor}.
 *
 * **Waking.** The contract makes a reattached sandbox *usable* the backend's obligation
 * (`SandboxProvider` in `@amond-ai/sandbox`). `Sandbox.get({ resume: false })` does not resume,
 * but the first `runCommand` or `readFileToBuffer` afterwards rides the SDK's own 410 → resume →
 * retry, so a session handed out here is usable by the time it answers anything. What discovery
 * avoids is therefore the *expensive* half, not all of it: `getProcess` against a name Vercel has
 * never heard of costs one 404 and creates nothing. Said plainly because the weaker claim is the
 * true one — this is not a backend that can inspect a resting sandbox without waking it.
 *
 * **Timing.** `SandboxProvider.session` is synchronous by contract, because the Cloudflare backend
 * resolves a Durable Object stub with no I/O and callers hold a session for one step at a time.
 * Acquiring a Vercel sandbox is a network call, so it is deferred to the session's first use and
 * memoised: `session(id)` on its own costs nothing, and a step that makes five calls acquires one
 * sandbox.
 */
import type {
  SandboxPortEndpoint,
  SandboxPortEndpointOptions,
  SandboxProvider,
  SandboxSession,
} from '@amond-ai/sandbox'
import type { VercelSandboxApi } from './vercel-api'
import type { VercelSessionOptions } from './vercel-session'
import type { VercelSandboxLike } from './vercel-surface'
import { createVercelSession } from './vercel-session'

export interface VercelProviderOptions extends Partial<Omit<VercelSessionOptions, 'journalRoot'>> {
  api: VercelSandboxApi
  /** Directory the process journal lives in, inside the sandbox. */
  stateRoot?: string
  /** Prefixed to every sandbox name, so one Vercel project can hold several deployments' runs. */
  namePrefix?: string
  /**
   * The sandbox name for an orchestrator sandbox id. **Must be injective.**
   *
   * Two ids that map to one name are two runs in one sandbox, which is the duplicate-turn hazard
   * with no journal in front of it. Defaults to {@link sandboxNameFor}.
   */
  sandboxName?: (sandboxId: string) => string
  /** Ports routed as part of acquiring the sandbox, before anything asks for one. */
  ports?: number[]
  /** The sandbox's lifetime. Passed to the session, which renews it while a wait is in flight. */
  sandboxTimeoutMs?: number
  /**
   * How much each renewal adds, when that should differ from {@link sandboxTimeoutMs}.
   *
   * Vercel's `extendTimeout` **adds** to the deadline rather than re-applying a window, and the
   * amount it may add is capped by the plan. A deployment whose plan cap is below its configured
   * lifetime sets this to something the cap accepts; everyone else leaves it alone.
   */
  extendTimeoutMs?: number
  /**
   * Whether `destroy()` also collects snapshots the sandbox left behind. Defaults to `true`.
   *
   * This provider never asks for a `persistent` sandbox, but the consumer who constructed the
   * `api` can have, through `VercelApiOptions.create` — and a persistent sandbox mints a snapshot
   * nothing else in this package ever collects.
   */
  deleteOrphanSnapshots?: boolean
}

const DEFAULT_STATE_ROOT = '/vercel/sandbox/.agent-runs'
/**
 * The most routed ports a sandbox may hold.
 *
 * Read from the SDK's own create parameters, which cap `ports` at 15. Enforced here rather than
 * left to the API so the refusal names what is already routed — see {@link ensureRouted}.
 */
const MAX_ROUTED_PORTS = 15
/** A DNS label: lowercase alphanumerics and inner hyphens, 1–63 characters. */
const DNS_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/
/**
 * The scheme a caller that named none gets.
 *
 * `https`, not `http`: a routed Vercel port is reached over the public internet through
 * `*.vercel.run`, so the plaintext reading would be the wrong default here even though it is the
 * right one for a port that never leaves a container.
 */
const DEFAULT_PROTOCOL = 'https'

/**
 * The scheme actually spoken for each one a caller can name — same kind, always over TLS.
 *
 * This is a provider overriding an explicit request, which needs justifying rather than noting.
 * `*.vercel.run` is an HTTPS edge: nothing listens on plaintext behind it, so honouring `'http'`
 * or `'ws'` literally could only hand back a URL that provably cannot be dialed. The alternative
 * to upgrading is not a stricter answer, it is a dead one — and refusing `'ws'` outright would
 * fail the one caller this exists for, since `@ai-sdk/harness-claude-code` asks for
 * `getPortEndpoint({ port, protocol: 'ws' })` and nothing else.
 *
 * The *kind* is preserved, because that is the part the caller knows and this provider does not:
 * `ws`→`wss` is a socket either way, `http`→`https` is a request either way. Carried verbatim
 * from the e2b backend, whose `TLS_SCHEME` records the measurement behind the same table.
 */
const TLS_SCHEME: Record<NonNullable<SandboxPortEndpointOptions['protocol']>, 'https' | 'wss'> = {
  http: 'https',
  https: 'https',
  ws: 'wss',
  wss: 'wss',
}

/**
 * The sandbox name for an orchestrator sandbox id — or a refusal.
 *
 * It throws where another backend would hash or slugify, and that is the whole point. A name is
 * the only identity Vercel offers, and it also becomes a subdomain, so a normalisation that maps
 * two ids onto one name puts two runs in one sandbox — and does it silently, in production, at
 * whichever collision happens first. A refusal happens at the first call instead, names the id
 * and the rule, and is fixed by choosing ids that are already DNS labels.
 */
export function sandboxNameFor(sandboxId: string, prefix = ''): string {
  const name = `${prefix}${sandboxId}`
  if (!DNS_LABEL.test(name)) {
    throw new Error(
      `sandbox id '${sandboxId}' does not make a usable Vercel sandbox name ('${name}').`
      + ' A name is this backend\'s only identity and also becomes a subdomain, so it must be a'
      + ' DNS label: 1-63 characters of lowercase letters, digits and inner hyphens.',
    )
  }
  return name
}

export function createVercelProvider(options: VercelProviderOptions): SandboxProvider {
  const journalRoot = options.stateRoot ?? DEFAULT_STATE_ROOT
  const nameOf = options.sandboxName ?? ((sandboxId: string) => sandboxNameFor(sandboxId, options.namePrefix))

  /**
   * Acquisitions currently in flight, one per sandbox id.
   *
   * `getOrCreate` is atomic on Vercel's side, so the race this closes is not two sandboxes — it is
   * two `VercelSandboxLike` objects for one sandbox, each with its own `routes` cache. That
   * matters more here than on e2b: {@link ensureRouted} repairs routing by calling `update` and
   * then re-reading `routes` on the object it holds, so a second object would answer from a cache
   * the first one's `update` never refreshed, and two concurrent bridge dials would each conclude
   * the other's port was missing.
   *
   * Shared while in flight and no longer: a settled acquisition is deliberately not memoised here.
   * `portEndpoint` is documented as costing a round trip, and a provider-level memo would outlive
   * a `destroy()` and hand back a dead sandbox.
   */
  const acquiring = new Map<string, Promise<VercelSandboxLike>>()

  /** Ports being repaired right now, per sandbox name — see {@link ensureRouted}. */
  const repairing = new Map<string, Promise<void>>()

  function routed(sandbox: VercelSandboxLike, port: number): boolean {
    return sandbox.routes.some(route => route.port === port)
  }

  /**
   * Make every port in `ports` reachable from outside the sandbox, and say so only when they are.
   *
   * Repair is not a convenience on this backend; it is what makes the package usable at all. The
   * `sdk` driver does not know the bridge's port until the host process prints `bridge-ready` with
   * it, which happens long after the sandbox was created — so a backend that could only route
   * ports at create time would make that driver impossible to run.
   *
   * Takes a *list* rather than a port, because the two callers want different things from it and
   * only one of them has to discover its port late. `portEndpoint` passes one, because one is all
   * it knows. Acquisition passes the whole configured set, and passing them one at a time made a
   * cold sandbox pay one `update` per port — `[3000]`, then `[3000, 3001]`, then
   * `[3000, 3001, 3002]` — three sequential remote round trips on the path that already has the
   * worst latency, for a routing state one call reaches. It also split the ceiling check: with 14
   * ports routed and 3 configured, the first call would succeed and the second fail, leaving the
   * sandbox routed in a shape nobody asked for.
   */
  async function ensureRouted(sandbox: VercelSandboxLike, ports: readonly number[]): Promise<void> {
    if (ports.every(port => routed(sandbox, port))) {
      return
    }
    const inFlight = repairing.get(sandbox.name)
    if (inFlight) {
      await inFlight
      if (ports.every(port => routed(sandbox, port))) {
        return
      }
    }
    const started = repair(sandbox, ports).finally(() => repairing.delete(sandbox.name))
    repairing.set(sandbox.name, started)
    await started
  }

  async function repair(sandbox: VercelSandboxLike, ports: readonly number[]): Promise<void> {
    const current = sandbox.routes.map(route => route.port)
    // The union, and it is mandatory rather than defensive: Vercel reads `ports` as the *full
    // desired list* and deregisters everything omitted, so sending only the ports being added
    // would silently unroute every port already in use — including the bridge this call is
    // trying to join.
    const next = [...new Set([...current, ...ports])]
    const named = `port${ports.length === 1 ? '' : 's'} ${ports.join(', ')}`
    if (next.length > MAX_ROUTED_PORTS) {
      // Loudly, and counting the whole union rather than one port at a time. Which port to drop
      // is a question this module has no way to answer and the caller does, and a check applied
      // per port would route some of a set it is about to refuse.
      throw new Error(
        `cannot route ${named} on sandbox '${sandbox.name}': that would need ${String(next.length)}`
        + ` routed ports of a maximum ${String(MAX_ROUTED_PORTS)}`
        + ` (already routed: ${current.join(', ')})`,
      )
    }
    await sandbox.update({ ports: next })
    // Verified rather than trusted, for the same reason `ensureRoot` re-checks its `mkdir`: an
    // `update` that resolved without registering the route would surface much later as `domain()`
    // throwing a bare `No route for port <p>` from somewhere that cannot explain it.
    const missing = ports.filter(port => !routed(sandbox, port))
    if (missing.length > 0) {
      throw new Error(
        `sandbox '${sandbox.name}' did not route port${missing.length === 1 ? '' : 's'}`
        + ` ${missing.join(', ')} after an update that reported success`,
      )
    }
  }

  async function getOrCreate(sandboxId: string): Promise<VercelSandboxLike> {
    const sandbox = await options.api.getOrCreate(nameOf(sandboxId))
    // One pass for the whole configured set: N ports is one `update`, not N.
    await ensureRouted(sandbox, options.ports ?? [])
    return sandbox
  }

  function acquire(sandboxId: string): Promise<VercelSandboxLike> {
    const inFlight = acquiring.get(sandboxId)
    if (inFlight) {
      return inFlight
    }
    const started = getOrCreate(sandboxId).finally(() => acquiring.delete(sandboxId))
    acquiring.set(sandboxId, started)
    return started
  }

  /**
   * One session per sandbox id, for this provider's lifetime.
   *
   * The run workflow calls `this.sandbox(id)` afresh in every step, so without this a single run
   * would acquire on each of them. The Cloudflare backend can hand back a new stub each time
   * because that costs no I/O; here it costs a round trip.
   */
  const sessions = new Map<string, SandboxSession>()

  return {
    backend: 'vercel',
    session: (sandboxId: string) => {
      const cached = sessions.get(sandboxId)
      if (cached) {
        return cached
      }
      const sessionOptions: VercelSessionOptions = {
        journalRoot,
        newProcessId: options.newProcessId,
        now: options.now,
        pollIntervalMs: options.pollIntervalMs,
        followIntervalMs: options.followIntervalMs,
        probeTimeoutMs: options.probeTimeoutMs,
        commandTimeoutMs: options.commandTimeoutMs,
        monotonicNowMs: options.monotonicNowMs,
        // Two numbers, deliberately. The lifetime seeds the deadline; the increment is what one
        // `extendTimeout` adds, which the plan caps separately. Collapsing them seeds the deadline
        // from the smaller number and renews a 30-minute sandbox from its third minute — see
        // `lifetime.ts`.
        sandboxTimeoutMs: options.sandboxTimeoutMs,
        extendTimeoutMs: options.extendTimeoutMs,
        deleteOrphanSnapshots: options.deleteOrphanSnapshots,
      }
      const created = lazySession({
        open: async () => createVercelSession(await acquire(sandboxId), sessionOptions),
        openExisting: async () => {
          const sandbox = await options.api.get(nameOf(sandboxId))
          return sandbox && createVercelSession(sandbox, sessionOptions)
        },
        release: async () => {
          const sandbox = await options.api.get(nameOf(sandboxId))
          // `undefined` makes release a no-op, which is what keeps release from being the thing
          // that allocates what it frees.
          // Not `stop()` then `delete`: `stop()` on a persistent sandbox mints the very snapshot
          // this is about to delete, and `delete` already ends the session.
          await sandbox?.delete({ deleteOrphanSnapshots: options.deleteOrphanSnapshots ?? true })
        },
      })
      sessions.set(sandboxId, created)
      return created
    },
    /**
     * A real, publicly routable address — which is why it costs a round trip and may cost an
     * `update`.
     *
     * The URL cannot be formatted from the id: only the sandbox knows the subdomain it was
     * assigned, and a port that is not registered has no address at all until one is made for it.
     * Both halves are why this acquires rather than computes.
     */
    portEndpoint: async (
      sandboxId: string,
      port: number,
      endpointOptions?: SandboxPortEndpointOptions,
    ): Promise<SandboxPortEndpoint> => {
      const sandbox = await acquire(sandboxId)
      await ensureRouted(sandbox, [port])
      // Never the scheme as asked when it is a plaintext one — {@link TLS_SCHEME} carries why.
      const protocol = TLS_SCHEME[endpointOptions?.protocol ?? DEFAULT_PROTOCOL]
      const url = new URL(sandbox.domain(port))
      url.protocol = `${protocol}:`
      // No `headers`. Vercel has no preview-token equivalent, so a routed port is reachable by
      // anyone who knows the subdomain, and there is nothing to hand a caller that would change
      // that. The bridge's own per-turn token in the query string is the only thing gating it.
      return { url: url.toString() }
    },
  }
}

interface LazySessionOptions {
  /** The sandbox for this id, creating one when Vercel holds none. */
  open: () => Promise<SandboxSession>
  /** Look up only — resolves `undefined` rather than creating one. */
  openExisting: () => Promise<SandboxSession | undefined>
  /** Delete the sandbox for this id; a no-op when Vercel holds none. */
  release: () => Promise<void>
}

/**
 * A session whose backing sandbox is acquired on first use and reused after.
 *
 * The promise is memoised rather than the resolved session so concurrent first calls share one
 * acquisition instead of racing.
 */
function lazySession(options: LazySessionOptions): SandboxSession {
  let pending: Promise<SandboxSession> | undefined
  const resolved = (): Promise<SandboxSession> => (pending ??= options.open().catch((cause: unknown) => {
    // Memoise the acquisition, not its failure. A rejected promise left in `pending` is rethrown
    // by every later call without touching Vercel again, so one transient error would outlive
    // itself and `PREPARE_RETRIES` could never recover from it — the retry would replay the
    // original rejection instead of retrying. Cleared on rejection only, so concurrent callers
    // still share one in-flight acquisition.
    pending = undefined
    throw cause
  }))

  /** The session for a sandbox that already exists, or `undefined` — never the thing that makes one. */
  const existing = async (): Promise<SandboxSession | undefined> =>
    pending ? await pending : await options.openExisting()

  return {
    // The file surface allocates on first use like every other call: a read is a use of the
    // sandbox, so it acquires one, rather than being answered against a session that is not there.
    readFile: (async (path: string, fileOptions?: { encoding?: string }) =>
      (await resolved()).readFile(path, fileOptions as { encoding: 'none' })) as SandboxSession['readFile'],
    writeFile: async (path, content, fileOptions) => (await resolved()).writeFile(path, content, fileOptions),
    mkdir: async (path, mkdirOptions) => (await resolved()).mkdir(path, mkdirOptions),
    exec: async (command, execOptions) => (await resolved()).exec(command, execOptions),
    /**
     * Discovery, which the contract says must not create anything.
     *
     * `packages/sandbox/src/types.ts` names `getProcess`/`listProcesses` non-waking discovery that
     * answers from cold state, and gives `exists` the job of booting — so routing these two
     * through the acquisition would make recovery asking whether a stale turn is still there
     * (`replay-turn.ts`) *create* a billable sandbox merely to be told `null`.
     *
     * "No sandbox" is an answer here rather than an error: nothing can be running in a sandbox
     * that does not exist, which is precisely what `null`/`[]` say. A sandbox Vercel still holds
     * is read — and reading it may wake it, since the SDK resumes on the first command; what is
     * avoided is the create.
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
     * `RunAgent.settle()` calls `releaseSandbox()` in a `finally`, so it also runs for a run that
     * was refused before it ever touched a sandbox — and it runs on a *different* instance from
     * the workflow that started the turn, so "this provider never acquired the session" does not
     * mean "no sandbox exists". Going through `open()` would create a sandbox purely to kill it,
     * while skipping the call whenever the session was never acquired would leak every sandbox the
     * workflow made. Looking up without creating is the reading that is right in both directions.
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
