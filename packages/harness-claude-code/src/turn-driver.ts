/**
 * The seam one turn runs through: `run-workflow.ts` starts, waits on and stops a turn by
 * calling a driver rather than by calling `sandbox.exec` / `process.logs` / `process.kill`
 * itself (ADR "turns run through the Agent SDK in a turn host", D3).
 *
 * Two drivers. `cli` is the incumbent: the `claude` CLI exec'd in the sandbox, watched by
 * sampling its log cursor, stopped with SIGINT and escalated to the backend's default kill.
 * `sdk` is the Agent SDK turn host, attached to over a WebSocket for one bounded round at a
 * time (D4). `TURN_DRIVER` picks between them, orthogonally to `SANDBOX_BACKEND`.
 *
 * Nothing here imports `cloudflare:workers` — including transitively, which is why the socket
 * opener arrives as {@link TurnDriverRun.openSocket} rather than being built here: `sdk-socket.ts`
 * reaches `@cloudflare/sandbox`, and importing it would make this module workerd-only along with
 * every test that wants to read the seam. The same split `sandbox-backend.ts` keeps from
 * `sandbox-provider.ts`.
 *
 * Two things the ADR's D3 sketch names are deliberately absent until they have a caller:
 *
 * - `attach`/`interrupt`/`sessionArtifacts` belong to the `sdk` driver's attach rounds (D4).
 *   The `cli` driver's watchdog loop is not attach rounds and returns from one `await`.
 * - `readTranscript` is not the turn's read. The settle-time replay lives in `replay-turn.ts`,
 *   on the Run Agent's Durable Object path rather than in the workflow, and the only
 *   `logs({ replay: true })` left in `run-workflow.ts` reads a *materialization's* stderr —
 *   preparation, not the turn. Moving either behind this interface would drag the DO path
 *   through a seam that exists for the attempt loop.
 */
import type { ApprovedRequest, DeferredToolUse, DeniedRequest, TurnHostOutboundMessage } from '@amond-ai/harness-protocol/claude-code'
import type { WsLike } from '@amond-ai/harness-transport'
import type { SandboxProvider } from '@amond-ai/sandbox'
import type { TurnDriverConfig } from './config'
import type { LiveMirror } from './mirror'
import type { AttemptOutcome, TurnTimeoutCause, TurnVerdict } from './outcome'
import type { PermissionMode } from './permission-mode'
import type { TurnRoundState } from './sdk/sdk-round-state'
import type { TurnDriverKind } from './turn-driver-kind'
import { cliTurnDriver } from './cli-turn-driver'
import { sdkTurnDriver } from './sdk/sdk-turn-driver'
import { parseTurnDriver } from './turn-driver-kind'

/**
 * One `claude` CLI invocation: the executable, then every argument in order.
 *
 * A tuple rather than `readonly string[]` because the reuse guard compares argv element by
 * element and the executable is the element that must not be optional. Built *outside* this
 * package — the flags, the plugin id and the settings sources a deployment gives a turn are the
 * consumer's, not the seam's — and handed in as {@link TurnDriverRun.claudeArgv}.
 */
export type ClaudeArgv = readonly [executable: string, ...args: string[]]

/**
 * What the `start-turn-N` step caches: the process the turn runs as, and when it was started.
 *
 * It is a Workflow step result, so it stays JSON-serialisable — and it is *replayed* rather
 * than recomputed, which is why the instant is pinned here rather than re-read from the
 * container on every entry into `await-exit`: `turnStartedAt` falls back to `Date.now()`
 * whenever `process.status()` rejects or answers a timestamp `Date.parse` cannot read, so a
 * restarted turn on a sick container — the case the wall-clock budget exists for — would be
 * handed a whole fresh budget on each restart.
 */
export interface TurnHandle {
  processId: string
  /**
   * Epoch millis, as the driver read the clock when it started or adopted the turn.
   *
   * Absent only for a workflow already in flight when the pinning deploy landed, whose cached
   * `start-turn-N` result is a bare process id string; `awaitTurn` then reads the instant off
   * the container, the behaviour it had before.
   */
  startedAtMs?: number
  /**
   * `sdk` only: the port that turn's host bound, chosen by the Worker rather than observed.
   *
   * On the handle because it is what the next attach round dials, and a round is a separate
   * step: the value has to survive the boundary the way every other step result does.
   */
  port?: number
  /**
   * `sdk` only: the per-turn credential the bridge gates its upgrade on.
   *
   * Never logged, never in argv. It authorises one bridge port inside one container this Worker
   * already controls end to end, which is why it is allowed to ride a step result at all —
   * `mintChannelToken` states the alternative and what it would cost.
   */
  token?: string
  /** `sdk` only: `--bridge-state-dir`, where the host journals the turn (D8). */
  bridgeStateDir?: string
}

/**
 * What one attempt needs to start its turn — the driver's whole input.
 *
 * The turn's *inputs* rather than its command line, because the two drivers spend them
 * differently: the `cli` driver builds `claude` argv around the prompt, while the `sdk` driver
 * starts a host that knows nothing about the turn and hands it the prompt in a frame. A spec
 * that carried argv would make the workflow build something one driver has no use for — and
 * would put the prompt in `listProcesses()` output for the driver that keeps it out.
 */
export interface TurnStartSpec {
  /** The fully assembled prompt, already recorded by the caller. */
  prompt: string
  /** The trust posture this run was dispatched under (FR-012); re-validated by each driver. */
  permissionMode: PermissionMode
  /**
   * The org posture appended to the turn's system prompt — the Claude Code preset stays, and this
   * text is added after it (`--append-system-prompt` on the `cli` path, `instructions` on the
   * host's `start` frame on the `sdk` one).
   *
   * The same text on every attempt of every run, deliberately: the `cli` driver's reuse guard
   * compares argv element by element, so a value that varied per attempt would make an adopted
   * turn look like a different command and start a second one beside it. It is also a
   * prompt-cache prefix, which a per-run value would break for a different reason.
   */
  instructions?: string
  /** Which attempt this is — a turn host's port and state directory are derived from it. */
  attempt: number
  /** Working directory for the turn, or `undefined` when the run has no checkout. */
  cwd: string | undefined
  /**
   * The turn's environment, assembled by the caller — and assembled *late*, on the driver's
   * `exec` path only.
   *
   * Assembled there rather than here on purpose: credentials, the git identity and the `gh`
   * auth marker are all read from `Env` under rules the caller states beside them (see
   * `githubCliEnv`), and a driver that reached for them itself would put that boundary in two
   * places. A driver receives an environment; it does not decide what a turn is trusted with.
   *
   * A thunk rather than a record for the same reason `beforeExec` is a callback: assembling it
   * can throw (`claudeCredentials` refuses a base URL without a credential), and a throw ahead
   * of the adoption guard would end a restarted workflow before it adopts the turn that is still
   * running — `onWorkflowError` settling the run and releasing the sandbox from under a healthy
   * process, over a deploy that only changed the gateway configuration.
   */
  env: () => Record<string, string>
  /** A process the Agent recorded for this run, if the first turn was started before. */
  recordedProcessId: string | undefined
  /** Process ids this workflow already started, which the reuse guard matches against. */
  started: readonly string[]
  /**
   * The session id this run's turns run under, minted once by the Run Agent (ADR D8, D6).
   *
   * The **Worker** owns it rather than the SDK, because the deferred-approval loop needs one
   * name for the conversation that survives a workflow instance: an id read back off the first
   * attempt's `finish` is a fact only *this* instance holds, and an approval may outlive the
   * instance as easily as it outlives the container. With the id minted up front, every attempt
   * of a run either resumes it or starts fresh *under it*, and the mirror key
   * (`sessions/<runId>/<sessionId>.jsonl`) is derivable before a single turn has run.
   *
   * Sent on the `start` frame only when {@link TurnStartSpec.resume} resolved to nothing —
   * `sessionId` and `resume` are the SDK's two mutually exclusive ways of naming a session. Set
   * by the workflow under `turnDriver === 'sdk'` alone; the `cli` driver has no field for it.
   */
  sessionId?: string
  /**
   * The one-shot answers a human gave to this run's deferred tool calls (ADR D6 layer 3), for
   * the attempt that is about to hear them.
   *
   * At most one entry each, and never both for the same request: one deferral is answered once.
   * They ride only on the attempt that follows the decision — the host consumes an entry on use,
   * so replaying them further would authorize a call nobody asked about. `sdk` only, for
   * {@link TurnStartSpec.sessionId}'s reason.
   */
  approvedRequests?: readonly ApprovedRequest[]
  deniedRequests?: readonly DeniedRequest[]
  /**
   * The tool patterns the host defers and refuses for this run, as pinned at dispatch.
   *
   * On the spec rather than read off the driver's config for the reason the answers above are:
   * a run parked on a decision outlives deploys, and the turn that resumes has to be governed by
   * the rules its own conversation was deferred by. Absent means the driver falls back to the
   * deployment's current lists, which is what an instance older than this field carries. `sdk`
   * only — the `cli` driver has no host to enforce them.
   */
  policy?: { deferTools?: readonly string[], refuseTools?: readonly string[] }
  /**
   * The session this attempt continues, when the attempt before it left one that can be
   * continued (ADR D8) — absent on a fresh start, which is every first attempt.
   *
   * **A thunk, and it is resolved on the exec path**, beside {@link TurnStartSpec.beforeExec}
   * and for the same kind of reason. What it answers is "is the session file in *this*
   * container" — not a durable fact, and not one a Workflow step may cache: a step result is
   * replayed rather than recomputed, so a re-entry after the container was replaced would
   * re-use a `{ resume: true }` decided about a filesystem that no longer exists, and the SDK
   * answers a `resume` whose transcript is missing by silently starting a *new* session under
   * that id. Resolved where the consequence is, the check and the `start` frame are one step.
   *
   * It never rejects: everything it cannot arrange resolves to `undefined` and the attempt
   * starts fresh (`run-session.ts`).
   *
   * Set by the workflow only under `turnDriver === 'sdk'`. The `cli` driver **throws** on it
   * rather than ignoring it: a driver that dropped it silently would start a fresh session while
   * the loop believed the turn was carrying the previous attempt's context.
   */
  resume?: () => Promise<TurnResume | undefined>
  /**
   * A check that runs only when a turn is really about to start — after the adoption guard,
   * before `exec`.
   *
   * The ordering is the point, and it is why this is a callback rather than something the
   * caller does before calling `start`: run ahead of the guard, a re-entry would read state
   * the *running* turn may have edited and could throw, settling the run and releasing the
   * sandbox out from under a process that is still live.
   */
  beforeExec?: () => Promise<void>
}

/** What the driver needs to watch a turn: the thresholds it judges by, and where bytes go. */
export interface TurnAwaitSpec {
  config: TurnDriverConfig
  mirror: LiveMirror | undefined
}

/**
 * A session an attempt may continue: the id the SDK resumes by, and the file that id names.
 *
 * Both or neither — an id with no transcript names a session nothing can be read from, which is
 * why {@link TurnSession}'s two optional members are narrowed to this before a resume is
 * considered at all.
 */
export interface TurnResume {
  sessionId: string
  transcriptPath: string
}

/**
 * Where the turn left the two files that outlive it, as the host named them (ADR D8).
 *
 * The host's own report, never the Worker's reconstruction: `~/.claude/projects/<encoded-cwd>`
 * is a CLI implementation detail, and the host is the process pinned to the same CLI patch as
 * the SDK it runs. The Worker mirrors these paths and passes them back; it does not build them.
 *
 * `sessionId` and `transcriptPath` are separately optional because the host reports them
 * separately: a turn under `persistSession: false` has an id and no file, and a turn that never
 * reached `system`/`init` has neither. Only an attempt carrying *both* can be resumed, which is
 * what `run-session.ts` gates on. `journalPath` is the bridge's own file and always exists.
 */
export interface TurnSession {
  sessionId?: string
  transcriptPath?: string
  journalPath: string
}

/**
 * How one turn ended, as observed from outside the process.
 *
 * `session` is the `sdk` driver's alone: it comes off the host's `finish` frame, and a `cli`
 * attempt has no host to report one — that driver leaves it `undefined` on every result.
 *
 * `verdict` is on one member only, and the omission is the statement (#376): a turn's own
 * `result` message decides whether *this* ending is worth another turn, but only where the
 * ending is the turn's to describe. A timeout was decided by a timer on this side, and a
 * deferral carries the request it is waiting on — neither is a judgment the transcript may
 * overrule, so neither member has a place to put one.
 */
export type AttemptResult
  = | {
    outcome: Exclude<AttemptOutcome, 'timed-out' | 'deferred'>
    exitCode?: number
    /** Only a timeout can leave a process possibly alive, so this is never set here. */
    killConfirmed?: undefined
    /** Only a timeout has a timer to name, so this is never set here. */
    timedOutBy?: undefined
    /** `sdk` only, and only from a `finish`: an `error` frame names no artifacts. */
    session?: TurnSession
    /**
     * What the turn's own terminal message said, when the driver read one going past.
     *
     * Absent means the turn printed no `result` this build could read — an empty stream, a turn
     * that died before printing, or schema drift — and the loop falls back to the exit-derived
     * `outcome`, which is what it judged on before this field existed.
     */
    verdict?: TurnVerdict
  }
  | {
    outcome: 'timed-out'
    exitCode?: number
    /**
     * Whether the process is known to be stopped. A supervisor timeout already reaped it;
     * a watchdog timeout relies on the driver's kill. `false` means the process may still be
     * running, so another attempt must not start. Required on this member so a timeout can
     * never reach `shouldStopAttemptLoop` with the answer left undecided.
     */
    killConfirmed: boolean
    /**
     * Which of the watchdog's two timers fired. Optional because the other two timeout paths
     * have no answer: a supervisor timeout was decided outside this workflow, and an abandoned
     * wait ended for a reason it did not name.
     */
    timedOutBy?: TurnTimeoutCause
    /**
     * `sdk` only. Present on this member too, because the *good* ending of a stop is a
     * `finish { stopped: 'interrupted' }` — a turn that answered `query.interrupt()` with a
     * real result, and whose session is exactly the one the next attempt should resume.
     */
    session?: TurnSession
    /** A timer ended this turn; the transcript does not get to overrule it. See above. */
    verdict?: undefined
  }
  | {
    /**
     * The turn stopped on a tool call a human has to answer (ADR D6 layer 3).
     *
     * Its own member rather than a flag on the others, because it carries an obligation none of
     * them do: {@link deferredToolUse} is required here, so a loop holding this result always has
     * the request to post and to match a decision against. A `finish { stopped: 'deferred' }`
     * that named none is protocol drift and is reported as `failed` instead
     * (`sdk-round-state.ts`), never as a deferral with nothing to decide.
     *
     * `sdk` only: the `cli` driver has no defer rule and never sends `deferTools`.
     */
    outcome: 'deferred'
    deferredToolUse: DeferredToolUse
    exitCode?: undefined
    killConfirmed?: undefined
    timedOutBy?: undefined
    /** The session the next attempt resumes to deliver the answer into the same conversation. */
    session?: TurnSession
    /** A deferral is a pending question, never a transient failure to retry. See above. */
    verdict?: undefined
  }

export type { TurnRoundState }

/** What one attach round needs; `previous` is the state the round before it stored. */
export interface TurnRoundSpec {
  config: TurnDriverConfig
  mirror: LiveMirror | undefined
  round: number
  previous: TurnRoundState | undefined
  /**
   * Every readable frame the round folds in, as the host sent it — the seam a consumer that
   * wants the turn's *events* rather than its outcome reads from.
   *
   * The attempt loop needs none of this: it is handed a `TurnRoundState` and judges the turn on
   * its outcome. A `HarnessV1` adapter needs each frame, because `HarnessAgent` is fed one
   * stream part at a time, and re-reading the journal to get them back would duplicate the
   * round's own consumption. The frame arrives parsed and validated, so a hook is never handed
   * something the round itself called unreadable, and it is called *before* a terminal frame
   * settles the round — a `finish` reaches the hook like any other.
   *
   * `seq` is the frame's own, as the runtime journaled it; absent on a frame that carries none.
   */
  onFrame?: (frame: TurnHostOutboundMessage, seq: number | undefined) => void
  /**
   * Ends the round the way its own window does — a suspend, not a stop.
   *
   * The round's boundary is the driver's to decide (wall clock, liveness) until a caller wants
   * to choose it: `HarnessV1.doSuspendTurn` freezes a turn at a precise cursor while the host
   * keeps running, which is exactly a window expiry with someone else's timer. So an abort tears
   * the round down as an expiry does — socket closed, state returned with `since` at the last
   * consumed frame and no outcome — and never as a timeout: nothing is interrupted, nothing is
   * killed, and the next round attaches from that cursor.
   */
  signal?: AbortSignal
}

interface TurnDriverBase {
  /** Start this attempt's turn, or adopt the live one a partially observed start left running. */
  start: (turn: TurnStartSpec) => Promise<TurnHandle>
  /**
   * Best-effort stop, answering whether the turn is known to be over.
   *
   * Not what the `cli` watchdog uses — that path reaches `killTurn` directly, inside
   * `cli-turn-watch.ts`, because the decision and the stop are one thing there. This is the
   * *loop-level* escalation: the ending only the caller can see, which the `sdk` driver needs
   * for a turn whose attach rounds ran out or whose host escalated on its own (D4). It is on the
   * interface because a stop is a driver's, not the loop's — both drivers end that ladder here,
   * and both end it the same way: SIGINT, then the backend's kill.
   */
  kill: (handle: TurnHandle) => Promise<boolean>
}

/**
 * One turn's lifecycle, as the attempt loop needs it — in one of two shapes.
 *
 * A tagged union rather than one interface with an optional round method, because the two ways
 * to wait are genuinely different and neither driver can do the other's. The `cli` driver waits
 * once, in one step, racing an exit against a log-cursor timer; the `sdk` driver attaches for a
 * bounded window at a time, one step per round, so a six-hour turn stays under the per-step CPU
 * meter and an eviction costs one round (D4). Written as an optional method instead, each driver
 * would carry a member it can never serve, and the workflow would branch on a truthiness check
 * where an exhaustive `switch` is available.
 */
export type TurnDriver
  = | (TurnDriverBase & {
    mode: 'single'
    /** Wait for the turn to end, racing the wait against the watchdog's liveness sampling. */
    await: (handle: TurnHandle, spec: TurnAwaitSpec) => Promise<AttemptResult>
  })
  | (TurnDriverBase & {
    mode: 'rounds'
    /** Consume frames for one bounded window, answering what the next round resumes from. */
    awaitRound: (handle: TurnHandle, spec: TurnRoundSpec) => Promise<TurnRoundState>
  })

/**
 * The driver this run's turns go through — the run's pinned kind, not the deployment's.
 *
 * The *provider* and an id, never a resolved session, for two independent reasons. A driver
 * outlives the step it was built in, and `SandboxProvider` requires a session to be resolved per
 * use because a Durable Object stub does not survive a step boundary — passing a session here
 * would make that violation the seam's default rather than a mistake a caller could make. And
 * the `sdk` driver has to ask `portEndpoint(sandboxId, port)` where its bridge is, the one
 * question a `SandboxSession` deliberately cannot answer (`@amond-ai/sandbox`,
 * `SandboxPortEndpoint`), which is what keeps the driver orthogonal to `SANDBOX_BACKEND`
 * instead of knowing which backend it is on.
 */
export function turnDriver(provider: SandboxProvider, run: TurnDriverRun): TurnDriver {
  // Re-parsed rather than trusted: the kind arrives in a workflow payload, which is JSON that
  // any dispatcher could have written, and a name this build does not know must refuse the run
  // here — before provisioning — rather than silently run the incumbent.
  if (parseTurnDriver(run.kind) === 'sdk') {
    return sdkTurnDriver({
      provider,
      sandboxId: run.sandboxId,
      config: run.config,
      runId: run.runId,
      openSocket: run.openSocket,
      settingSources: run.settingSources,
    })
  }
  return cliTurnDriver(provider, run.sandboxId, run.claudeArgv)
}

/** What a driver needs to know about the run it is being built for. */
export interface TurnDriverRun {
  sandboxId: string
  runId: string
  config: TurnDriverConfig
  /**
   * Dial one bridge endpoint URL — the `sdk` driver's only unstubbable dependency.
   *
   * Passed in rather than built here because opening the socket is the one part that cannot run
   * outside workerd (`sdk-socket.ts` reaches `@cloudflare/sandbox`), and this module has to stay
   * importable from `bun test`. `run-workflow.ts` is workerd-only already, so it passes
   * `turnHostSocketOpener(env)`; the `cli` driver never calls it.
   */
  openSocket: (url: string) => Promise<WsLike>
  /**
   * Which driver to build — the run's own, pinned at dispatch, never `TURN_DRIVER` read here.
   *
   * A run outlives a deploy, and the two drivers' handles are not interchangeable: re-reading the
   * flag on a workflow re-entry would hand a `cli` handle to the sdk attach path or an sdk host
   * to the cli watcher. `run-workflow.ts` resolves it from the payload (`RunWorkflowParams`).
   */
  kind: TurnDriverKind
  /**
   * Build the `cli` driver's argv for one turn — the seam's other unstubbable dependency.
   *
   * Injected rather than built here because what a `claude` turn is invoked with is the
   * consumer's decision, not the seam's: the flags, the plugin it enables and the settings
   * sources it reads are Pleaseworks' (`claude-run.ts`), and a driver that built them would
   * carry one deployment's policy into every other one. The `sdk` driver never calls it.
   */
  claudeArgv: (turn: TurnStartSpec) => ClaudeArgv
  /**
   * `settingSources` as the `sdk` driver's `start` frame carries it — the same list the `cli`
   * argv names, passed in for the same reason {@link claudeArgv} is.
   */
  settingSources: readonly string[]
}
