/**
 * `SandboxProvider` over Daytona, and the two things that need reconciling to get there.
 *
 * **Identity.** The contract addresses a sandbox by the id the orchestrator chose
 * (`sandboxIdForRun(runId)`); Daytona mints its own. So the orchestrator's id is written into a
 * Daytona **label** at create time and looked up through `list({ labels })`, which matches
 * sandboxes in *every* state rather than only running ones (research note 035 §6) — a retried
 * workflow step must reach the sandbox its predecessor left behind, whatever state Daytona put it
 * in. There is no `findOne()` in 0.211.2; the first item of the listing is the answer.
 *
 * **Timing.** `SandboxProvider.session` is synchronous by contract, because the Cloudflare
 * backend resolves a Durable Object stub with no I/O and callers hold a session for one step at a
 * time. Acquiring a Daytona sandbox is a network call, so it is deferred to the session's first
 * use and memoised: `session(id)` on its own costs nothing, and a step that makes five calls
 * creates one sandbox.
 */
import type {
  SandboxPortEndpoint,
  SandboxPortEndpointOptions,
  SandboxProvider,
  SandboxSession,
} from '@amond-ai/sandbox'
import type { DaytonaSandboxLike, DaytonaSessionOptions } from './daytona-session'
import { createDaytonaSession } from './daytona-session'

/** The `Daytona` client calls this provider needs, structural so tests can stand in for them. */
export interface DaytonaSandboxApi {
  create: (params: {
    snapshot?: string
    labels?: Record<string, string>
    envVars?: Record<string, string>
    /** Minutes of *inactivity* before Daytona stops the sandbox. `0` disables it. */
    autoStopInterval?: number
  }) => Promise<DaytonaSandboxLike>
  connect: (sandboxId: string) => Promise<DaytonaSandboxLike>
  list: (query: { labels?: Record<string, string> }) => Promise<{ id: string }[]>
}

export interface DaytonaProviderOptions extends Partial<Omit<DaytonaSessionOptions, 'stateRoot'>> {
  api: DaytonaSandboxApi
  /** Daytona snapshot the sandbox boots from. Unset falls through to Daytona's default. */
  snapshot?: string
  /** Directory the pid and meta files live in, inside the sandbox. */
  stateRoot?: string
  /** Environment baked into the sandbox — model credentials, git identity. */
  envVars?: Record<string, string>
  /**
   * Minutes of inactivity Daytona stops the sandbox after. Unset leaves Daytona's own default
   * (15 minutes), which is shorter than a turn; `0` disables the stop entirely.
   */
  autoStopIntervalMinutes?: number
  /**
   * How long a reattach waits for a sandbox caught `archiving` or `pausing` to settle before
   * giving up. Defaults to {@link DEFAULT_SETTLE_TIMEOUT_MS}; the re-read cadence is
   * `pollIntervalMs`, shared with the process waits.
   */
  settleTimeoutMs?: number
}

/** Daytona's default sandbox user is `daytona`, and `$HOME` is where its shell can write. */
const DEFAULT_STATE_ROOT = '/home/daytona/.agent-runs'
/** The label carrying the orchestrator's own sandbox id. */
export const SANDBOX_ID_LABEL = 'pleaseSandboxId'
/** How often a settling sandbox is re-read, when the caller set no `pollIntervalMs`. */
const DEFAULT_SETTLE_POLL_MS = 1_000
/** How long the re-reads go on — the same 60 seconds the SDK's own `waitUntil*` default to. */
const DEFAULT_SETTLE_TIMEOUT_MS = 60_000

/**
 * The scheme a caller that named none gets.
 *
 * `https`, not `http`: a Daytona preview host is reached over the public internet with TLS
 * terminated at Daytona's edge, so the plaintext reading would be the wrong default here even
 * though it is the right one for a port that never leaves a container.
 */
const DEFAULT_PROTOCOL = 'https'

/**
 * The scheme actually spoken for each one a caller can name — same kind, always over TLS.
 *
 * The same reasoning the e2b backend's `TLS_SCHEME` sets out, from the same fact: a preview link
 * is a public HTTPS endpoint (`getPreviewLink` hands back one, and nothing listens on plaintext
 * behind it), so honouring `'http'` or `'ws'` literally could only hand back a URL that provably
 * cannot be dialed. Refusing them outright is not the stricter alternative — it fails the very
 * caller this exists for, since `@ai-sdk/harness-claude-code` asks for `protocol: 'ws'` and
 * nothing else. The *kind* is preserved, because that is the part the caller knows and this
 * provider does not: `ws`→`wss` is a socket either way, `http`→`https` is a request either way.
 */
const TLS_SCHEME: Record<NonNullable<SandboxPortEndpointOptions['protocol']>, 'https' | 'wss'> = {
  http: 'https',
  https: 'https',
  ws: 'wss',
  wss: 'wss',
}

/** How Daytona authenticates a preview request that can carry headers. */
const PREVIEW_TOKEN_HEADER = 'x-daytona-preview-token'
/**
 * How it authenticates one that cannot.
 *
 * A WebSocket opened from a browser or a serverless runtime has no way to set a request header,
 * which is why Daytona's own SDK appends the token as this query parameter instead
 * (`esm/utils/WebSocket.js`, research note 035 §3). Both are emitted for a socket: the header
 * costs nothing where it is honoured, and the query parameter is what actually authenticates the
 * dial workerd makes.
 */
const PREVIEW_TOKEN_PARAM = 'DAYTONA_SANDBOX_AUTH_KEY'

export function createDaytonaProvider(options: DaytonaProviderOptions): SandboxProvider {
  const stateRoot = options.stateRoot ?? DEFAULT_STATE_ROOT

  /** The sandbox Daytona already holds for this id, without minting one that is not there. */
  async function connect(sandboxId: string): Promise<DaytonaSandboxLike | undefined> {
    const existing = await options.api.list({ labels: { [SANDBOX_ID_LABEL]: sandboxId } })
    const found = existing[0]
    return found ? options.api.connect(found.id) : undefined
  }

  const settle: SettleOptions = {
    pollMs: options.pollIntervalMs ?? DEFAULT_SETTLE_POLL_MS,
    timeoutMs: options.settleTimeoutMs ?? DEFAULT_SETTLE_TIMEOUT_MS,
    elapsedMs: options.monotonicNowMs ?? (() => performance.now()),
  }

  async function listThenCreate(sandboxId: string): Promise<DaytonaSandboxLike> {
    const existing = await connect(sandboxId)
    if (existing) {
      return await woken(existing, settle)
    }
    // `autoPauseInterval` is deliberately not sent. Auto-pause exists only for VM sandbox classes
    // and is refused for container ones (Daytona docs, "Auto-pause sandboxes": "Auto-pause is not
    // supported for container sandboxes"), and a snapshot built from `docker/Dockerfile` — which
    // is the only kind a turn host ships in — is a container. The 60-minute auto-pause default
    // applies "when neither interval is provided", and `autoStopInterval` is provided whenever
    // the caller set one, `0` included. Sending `autoPauseInterval: 0` beside it would buy
    // nothing on a container and risks a rejected create on a class the field is not allowed for
    // (#468).
    return options.api.create({
      snapshot: options.snapshot,
      labels: { [SANDBOX_ID_LABEL]: sandboxId },
      envVars: options.envVars,
      autoStopInterval: options.autoStopIntervalMinutes,
    })
  }

  /** Acquisitions currently in flight, one per sandbox id. */
  const acquiring = new Map<string, Promise<DaytonaSandboxLike>>()

  /**
   * The list-then-create walk, shared by everyone who starts it at the same time.
   *
   * `lazySession` already memoises, but only per session object, and it memoises the *session* —
   * `portEndpoint` needs the `DaytonaSandboxLike` underneath it, which a `SandboxSession` has no
   * way to hand back, so it reaches here directly. Two first calls in flight at once would
   * therefore both list, both find nothing, and both create: two sandboxes for one id, one of
   * them orphaned with nothing left holding a handle to delete it.
   *
   * Shared while in flight and no longer: a settled acquisition is deliberately not memoised
   * here, because a provider-level memo would outlive a `destroy()` and hand back a deleted
   * sandbox. Once the walk has settled the sandbox is listable, so the next caller reattaches.
   */
  function acquire(sandboxId: string): Promise<DaytonaSandboxLike> {
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
   * The run workflow calls `this.sandbox(id)` afresh in every step, so without this a single run
   * would list-and-connect on each of them.
   */
  const sessions = new Map<string, SandboxSession>()

  return {
    backend: 'daytona',
    session: (sandboxId: string) => {
      const cached = sessions.get(sandboxId)
      if (cached) {
        return cached
      }
      const sessionOptions: DaytonaSessionOptions = {
        stateRoot,
        newProcessId: options.newProcessId,
        now: options.now,
        pollIntervalMs: options.pollIntervalMs,
        followIntervalMs: options.followIntervalMs,
        monotonicNowMs: options.monotonicNowMs,
      }
      const created = lazySession({
        open: async () => createDaytonaSession(await acquire(sandboxId), sessionOptions),
        openExisting: async () => {
          const sandbox = await connect(sandboxId)
          return sandbox && createDaytonaSession(sandbox, sessionOptions)
        },
      })
      sessions.set(sandboxId, created)
      return created
    },
    /**
     * A real, publicly routable address — which is why it costs a round trip.
     *
     * The id in hand is the orchestrator's and Daytona has never heard of it (see the header), so
     * the host cannot be formatted from it: only the sandbox Daytona actually holds knows what it
     * was assigned, and `getPreviewLink` is itself a call.
     */
    portEndpoint: async (
      sandboxId: string,
      port: number,
      endpointOptions?: SandboxPortEndpointOptions,
    ): Promise<SandboxPortEndpoint> => {
      const sandbox = await acquire(sandboxId)
      const preview = await sandbox.getPreviewLink(port)
      const kind = endpointOptions?.protocol ?? DEFAULT_PROTOCOL
      const url = new URL(preview.url)
      // Never the scheme as asked when it is a plaintext one — {@link TLS_SCHEME} carries why.
      url.protocol = `${TLS_SCHEME[kind]}:`
      if (TLS_SCHEME[kind] === 'wss') {
        url.searchParams.set(PREVIEW_TOKEN_PARAM, preview.token)
      }
      return { url: url.toString(), headers: { [PREVIEW_TOKEN_HEADER]: preview.token } }
    },
  }
}

/**
 * The states a reattached sandbox is woken from — stopped by auto-stop, archived after it, or
 * paused.
 *
 * `paused` is on the same footing as the other two even though nothing here asks for a pause:
 * `SandboxState` in 0.211.2 carries `pausing`/`paused`/`resuming`, `Sandbox.pause()` is public,
 * and a VM sandbox class auto-pauses after 60 minutes when *neither* interval is given at create
 * time — which this provider allows, since `autoStopIntervalMinutes` is optional. A container
 * sandbox, which is what a snapshot built from a Dockerfile is, cannot pause at all (Daytona
 * docs, "Pause / resume sandboxes"), so on the orchestrator's own snapshot this branch is
 * unreachable; it stays because the provider does not know which class it was pointed at.
 * `start()` is the way back up from it: 0.211.2 ships no `resume`, and the API has only
 * `startSandbox` (Codex review, PR #463).
 */
const STARTABLE = new Set(['stopped', 'archived', 'paused'])

/** The states that are already on their way up: waited for, never started a second time. */
const COMING_UP = new Set(['starting', 'restoring', 'creating', 'pulling_snapshot', 'resuming'])

/**
 * On its way *down*, which is the state a reattach races the auto-stop timer into.
 *
 * `stopping` is neither running nor startable: issuing `fs`/`process` calls at it means talking to
 * a sandbox mid-shutdown, and `start()` has nothing to act on yet. So it is settled first — Daytona
 * exposes `waitUntilStopped` for exactly this — and then woken like any other stopped sandbox
 * (Codex review, PR #463).
 *
 * `archiving` and `pausing` are not here because `waitUntilStopped` cannot settle them: they end
 * in `archived` and `paused` rather than `stopped`, so it would time out instead. They have their
 * own set, {@link SETTLING_BY_POLL}.
 */
const SETTLING = new Set(['stopping'])

/**
 * On its way down into a resting state that is *not* `stopped`, so settled by re-reading instead.
 *
 * 0.211.2 ships no `waitUntilArchived`/`waitUntilPaused` and the API has no equivalent endpoint
 * (research note 035 §2); `refreshData()` is the only primitive, so this package polls it. A
 * reattach used to get Daytona's own error in either window and rely on the step being retried
 * (#468). `archiving` is the one that actually happens on the orchestrator's snapshot — a
 * container sandbox is auto-archived after it has been stopped for `autoArchiveInterval`, seven
 * days by default — and `pausing` is the VM-class twin, covered for the same reason `paused` is.
 *
 * The exit state is not assumed: `Sandbox.pause()` in 0.211.2 treats leaving `pausing` as done
 * whatever state follows, so the settled state is dispatched like a freshly read one — started
 * if startable, waited for if coming up, and left alone otherwise.
 */
const SETTLING_BY_POLL = new Set(['archiving', 'pausing'])

interface SettleOptions {
  pollMs: number
  timeoutMs: number
  /** Monotonic milliseconds, injectable so a test can reach the deadline without waiting for it. */
  elapsedMs: () => number
}

/**
 * The state a sandbox caught in {@link SETTLING_BY_POLL} ends up in, or an error once
 * `timeoutMs` has passed without it leaving.
 *
 * The timeout is an error rather than a fall-through on purpose: handing the still-settling
 * sandbox on would end in a Daytona error from whichever `fs`/`process` call came first, which
 * names neither the state nor how long it was waited for.
 */
async function settledByPoll(sandbox: DaytonaSandboxLike, settle: SettleOptions): Promise<string | undefined> {
  const startedAt = settle.elapsedMs()
  const deadline = startedAt + settle.timeoutMs
  const expired = (at: number): Error =>
    new Error(`daytona sandbox ${sandbox.id} is still ${sandbox.state ?? 'settling'} after ${String(Math.round(at - startedAt))}ms`)
  while (true) {
    // Read before spending the round trip, not after it. A budget carried across the nap would be
    // the one computed *before* it, so an event loop that returns late from `setTimeout` would
    // hand the next refresh a stale, too-generous allowance and let a sandbox come back past the
    // deadline it was given.
    const at = settle.elapsedMs()
    if (at >= deadline) {
      throw expired(at)
    }
    await refreshedWithin(sandbox, deadline - at, () => expired(settle.elapsedMs()))
    const state = sandbox.state
    if (state === undefined || !SETTLING_BY_POLL.has(state)) {
      return state
    }
    // Read again rather than reusing `at`, which predates the round trip: a slow refresh would
    // leave it overstating what is left, and the nap would spend a full `pollMs` on a deadline
    // that is already at hand.
    const remaining = deadline - settle.elapsedMs()
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Math.min(settle.pollMs, remaining))))
  }
}

/**
 * One `refreshData()` round trip, bounded by what is left of the settle deadline.
 *
 * Awaiting it outright would enforce `timeoutMs` only *between* round trips, because the loop
 * reaches its deadline check once the call has returned: a Daytona request that stalls carries the
 * reattach past the bound the caller was promised, and one that answers late could still hand a
 * rested sandbox back after that bound had passed. Racing it against the remainder bounds the
 * acquisition itself. The abandoned request keeps the rejection handler `Promise.race` attached to
 * it, so a refusal arriving after the race was decided is never an unhandled rejection.
 */
async function refreshedWithin(sandbox: DaytonaSandboxLike, withinMs: number, expired: () => Error): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      sandbox.refreshData(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(expired())
        }, Math.max(0, withinMs))
      }),
    ])
  }
  finally {
    clearTimeout(timer)
  }
}

/**
 * A reattached sandbox, brought back up before anything asks it for work.
 *
 * The label lookup deliberately passes no `states` filter, because a retried step must reach the
 * sandbox its predecessor left behind whatever state Daytona put it in (research note 035 §6) —
 * and that is exactly what lets a *stopped* one through. `daytona.get()` answers with the sandbox
 * either way; nothing about holding one starts it. So a run parked longer than
 * `autoStopInterval` — an SDK turn waiting on a human approval, whose timeout is 24 hours against
 * an hour-long default — would reattach and then issue filesystem and process calls at a sandbox
 * that is not running (Codex review, PR #463).
 *
 * Four groups are acted on and the rest are left alone on purpose. `stopped`/`archived`/`paused`
 * are the resting states Daytona's own lifecycle puts a sandbox in, and `start()` covers all three
 * — it restores an archived sandbox and resumes a paused one, and 0.211.2 offers no other way up.
 * `stopping` is settled into `stopped` first, then woken the same way; `archiving`/`pausing` are
 * settled by re-reading until they rest, then dispatched on whatever they rested in. Transitional
 * up-states are already coming up, so they are waited for rather than started again. A state that
 * is `started`, absent, or terminal (`destroyed`, `error`, …) is not this function's to fix:
 * starting the first is a wasted round trip, and the other two would replace Daytona's own error
 * with a less useful one from `start`.
 *
 * Only the acquisition path calls this. `destroy()` reaches Daytona through `openExisting`, and
 * waking a sandbox purely to delete it would pay for a boot nobody uses.
 */
async function woken(sandbox: DaytonaSandboxLike, settle: SettleOptions): Promise<DaytonaSandboxLike> {
  let state = sandbox.state
  if (state !== undefined && SETTLING_BY_POLL.has(state)) {
    state = await settledByPoll(sandbox, settle)
  }
  if (state === undefined || !(STARTABLE.has(state) || COMING_UP.has(state) || SETTLING.has(state))) {
    return sandbox
  }
  if (SETTLING.has(state)) {
    await sandbox.waitUntilStopped()
  }
  if (STARTABLE.has(state) || SETTLING.has(state)) {
    await sandbox.start()
  }
  // `start()` returns once Daytona accepted the ask, not once the toolbox answers — so the wait is
  // the part that makes the next `fs`/`process` call safe, and it runs on every branch.
  await sandbox.waitUntilStarted()
  return sandbox
}

interface LazySessionOptions {
  /** Connect to the sandbox for this id, creating one when Daytona holds none. */
  open: () => Promise<SandboxSession>
  /** Connect only — resolves `undefined` rather than creating one. */
  openExisting: () => Promise<SandboxSession | undefined>
}

/**
 * A session whose backing sandbox is acquired on first use and reused after.
 *
 * The promise is memoised rather than the resolved session so concurrent first calls share one
 * acquisition instead of racing to create two sandboxes for the same id.
 */
function lazySession(options: LazySessionOptions): SandboxSession {
  let pending: Promise<SandboxSession> | undefined
  const resolved = (): Promise<SandboxSession> => (pending ??= options.open().catch((cause: unknown) => {
    // Memoise the acquisition, not its failure. A rejected promise left in `pending` is rethrown
    // by every later call without touching Daytona again, so one transient `list` or `create`
    // error would outlive itself and `PREPARE_RETRIES` could never recover from it. Cleared on
    // rejection only, so concurrent callers still share one in-flight acquisition.
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
    readFile: (async (path: string, fileOptions?: { encoding?: string }) =>
      (await resolved()).readFile(path, fileOptions as { encoding: 'none' })) as SandboxSession['readFile'],
    writeFile: async (path, content, fileOptions) => (await resolved()).writeFile(path, content, fileOptions),
    mkdir: async (path, mkdirOptions) => (await resolved()).mkdir(path, mkdirOptions),
    exec: async (command, execOptions) => (await resolved()).exec(command, execOptions),
    /**
     * Discovery, which the contract says must not wake anything.
     *
     * `packages/amond-ai/sandbox/src/types.ts` names `getProcess`/`listProcesses` non-waking calls that
     * answer from cold state, and gives `exists` the job of booting — so routing these two through
     * the acquisition would break the contract twice over on this backend: recovery asking whether
     * a stale turn is still there would *create* a billable sandbox merely to be told `null`, and
     * since the reattach wake, boot a stopped one as well (Codex review, PR #463).
     *
     * "No sandbox" is an answer here rather than an error: nothing can be running in a sandbox
     * that does not exist, which is precisely what `null`/`[]` say.
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
     * mean "no sandbox exists". Going through `open()` would create a sandbox purely to delete
     * it; skipping the call whenever the session was never acquired would leak every sandbox the
     * workflow made. Connecting without creating is right in both directions.
     */
    destroy: async () => {
      await (await existing())?.destroy()
    },
  }
}
