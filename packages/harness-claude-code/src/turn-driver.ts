/**
 * The seam one turn runs through: `run-workflow.ts` starts, waits on and stops a turn by
 * calling a driver rather than by calling `sandbox.exec` / `process.logs` / `process.kill`
 * itself (ADR "turns run through the Agent SDK in a turn host", D3).
 *
 * One driver behind it: the Agent SDK turn host, attached to over a WebSocket for one bounded
 * round at a time (D4), stopped with an `interrupt` and then SIGINT escalated to the backend's
 * default kill. It runs orthogonally to `SANDBOX_BACKEND`.
 *
 * Nothing here imports `cloudflare:workers` — including transitively, which is why the socket
 * opener arrives as {@link TurnDriverRun.openSocket} rather than being built here: `sdk-socket.ts`
 * reaches the Cloudflare sandbox binding, and importing it would make this module workerd-only along with
 * every test that wants to read the seam. The same split `sandbox-backend.ts` keeps from
 * `sandbox-provider.ts`.
 *
 * Two things the ADR's D3 sketch names are deliberately absent until they have a caller:
 *
 * - `attach`/`interrupt`/`sessionArtifacts` are not methods of their own: they happen inside
 *   {@link TurnDriver.awaitRound}'s attach rounds (D4).
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
import type { AttemptOutcome, HostLoss, TurnTimeoutCause, TurnVerdict } from './outcome'
import type { PermissionMode } from './permission-mode'
import type { TurnRoundState } from './sdk/sdk-round-state'
import { sdkTurnDriver } from './sdk/sdk-turn-driver'

/**
 * What the `start-turn-N` step caches: the process the turn runs as, and when it was started.
 *
 * It is a Workflow step result, so it stays JSON-serialisable — and it is *replayed* rather
 * than recomputed, which is why the instant is pinned here rather than re-read from the
 * container on every round: a status read can fail or answer a timestamp `Date.parse` cannot
 * read, so a restarted turn on a sick container — the case the wall-clock budget exists for —
 * would be handed a whole fresh budget on each restart.
 */
export interface TurnHandle {
  processId: string
  /**
   * Epoch millis, as the driver read the clock when it started or adopted the turn.
   *
   * Absent only for a workflow already in flight when the pinning deploy landed, whose cached
   * `start-turn-N` result is a bare process id string; the round then budgets from its own start.
   */
  startedAtMs?: number
  /**
   * The port that turn's host bound, chosen by the Worker rather than observed.
   *
   * On the handle because it is what the next attach round dials, and a round is a separate
   * step: the value has to survive the boundary the way every other step result does.
   */
  port?: number
  /**
   * The per-turn credential the bridge gates its upgrade on.
   *
   * Never logged, never in argv. It authorises one bridge port inside one container this Worker
   * already controls end to end, which is why it is allowed to ride a step result at all —
   * `mintChannelToken` states the alternative and what it would cost.
   */
  token?: string
  /** `--bridge-state-dir`, where the host journals the turn (D8). */
  bridgeStateDir?: string
}

/**
 * What one attempt needs to start its turn — the driver's whole input.
 *
 * The turn's *inputs* rather than its command line: the driver starts a host that knows nothing
 * about the turn and hands it the prompt in a frame. A spec that carried argv would put the
 * prompt in `listProcesses()` output, which is exactly where it is kept out of.
 */
export interface TurnStartSpec {
  /** The fully assembled prompt, already recorded by the caller. */
  prompt: string
  /** The trust posture this run was dispatched under (FR-012); re-validated by the driver. */
  permissionMode: PermissionMode
  /**
   * The org posture appended to the turn's system prompt — the Claude Code preset stays, and this
   * text is added after it (`instructions` on the host's `start` frame).
   *
   * The same text on every attempt of every run, deliberately: it is a prompt-cache prefix, which
   * a per-run value would break.
   */
  instructions?: string
  /**
   * The model this turn runs on, as the consumer named it for the turn: the `model` of the
   * host's `start` frame. Absent means the Agent SDK's default model.
   */
  model?: string
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
   * `sessionId` and `resume` are the SDK's two mutually exclusive ways of naming a session.
   */
  sessionId?: string
  /**
   * The one-shot answers a human gave to this run's deferred tool calls (ADR D6 layer 3), for
   * the attempt that is about to hear them.
   *
   * At most one entry each, and never both for the same request: one deferral is answered once.
   * They ride only on the attempt that follows the decision — the host consumes an entry on use,
   * so replaying them further would authorize a call nobody asked about.
   */
  approvedRequests?: readonly ApprovedRequest[]
  deniedRequests?: readonly DeniedRequest[]
  /**
   * The tool patterns the host defers and refuses for this run, as pinned at dispatch.
   *
   * On the spec rather than read off the driver's config for the reason the answers above are:
   * a run parked on a decision outlives deploys, and the turn that resumes has to be governed by
   * the rules its own conversation was deferred by. Absent means the driver falls back to the
   * deployment's current lists, which is what an instance older than this field carries.
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
 * `session` comes off the host's `finish` frame, so only an ending the host reported carries one.
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
    /** Only an abandoned wait reads a lost host, and that ending is a timeout. */
    hostLost?: undefined
    /** Only from a `finish`: an `error` frame names no artifacts. */
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
     * wait names only the stop this side asked for, if any.
     */
    timedOutBy?: TurnTimeoutCause
    /**
     * Why a round abandoned the turn as gone with no terminal frame — what the
     * probe read and how the socket had ended. Absent on every other timeout.
     */
    hostLost?: HostLoss
    /**
     * Present on this member too, because the *good* ending of a stop is a
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
     */
    outcome: 'deferred'
    deferredToolUse: DeferredToolUse
    exitCode?: undefined
    killConfirmed?: undefined
    timedOutBy?: undefined
    hostLost?: undefined
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
   *
   * **At least once, keyed by `seq`.** Rounds that returned hand each frame over once: the next
   * one attaches past the `since` the last one committed. A step that *failed* is different. Its
   * retry resumes from the committed `since`, which can be behind what the failed attempt
   * already handed over, and the replay reports those frames again — a `finish` or an `error`
   * included — under the `seq` they carried the first time. Only frames at or below the live
   * mirror's cursor are held back, because that cursor is the one record a failed step leaves.
   * The round cannot do better (#26): a publication cursor stored with the mirror's puts would
   * still trail the reports, since a frame is reported when it arrives and a put lands on the
   * flush cadence, so a step that fails between the two re-reports it all the same. A consumer
   * whose effect must happen once keeps the highest `seq` it has taken, durably when the effect
   * outlives the step, and drops a frame at or below it. That mark belongs to one host process:
   * the runtime's `seq` is monotonic across a process and starts over with each host this driver
   * starts (it never sets `BRIDGE_REPLAY_FROM_DISK`, the one mode in which a respawned host
   * continues its journal's `seq`), so a mark carried to another host would drop its frames. Key it by the {@link TurnHandle}'s
   * `processId` the round attaches to. The run and attempt are not enough — a `HarnessV1`
   * session's next prompt starts a new host under the same ones. A live-only frame — a token
   * delta, which the runtime does not journal — is never replayed, so it is never repeated
   * either.
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

/**
 * One turn's lifecycle, as the attempt loop needs it: start it, consume it a bounded round at a
 * time, and stop it.
 *
 * The turn is waited on in rounds rather than once, so a six-hour turn stays under the per-step
 * CPU meter and an eviction costs one round (D4).
 */
export interface TurnDriver {
  /** Start this attempt's turn, or adopt the live one a partially observed start left running. */
  start: (turn: TurnStartSpec) => Promise<TurnHandle>
  /** Consume frames for one bounded window, answering what the next round resumes from. */
  awaitRound: (handle: TurnHandle, spec: TurnRoundSpec) => Promise<TurnRoundState>
  /**
   * Best-effort stop, answering whether the turn is known to be over.
   *
   * The *loop-level* escalation: the ending only the caller can see, for a turn whose attach
   * rounds ran out or whose host escalated on its own (D4). It is on the interface because a stop
   * is a driver's, not the loop's, and it ends the same way every time: SIGINT, then the
   * backend's kill.
   */
  kill: (handle: TurnHandle) => Promise<boolean>
}

/**
 * The driver this run's turns go through.
 *
 * The *provider* and an id, never a resolved session, for two independent reasons. A driver
 * outlives the step it was built in, and `SandboxProvider` requires a session to be resolved per
 * use because a Durable Object stub does not survive a step boundary — passing a session here
 * would make that violation the seam's default rather than a mistake a caller could make. And
 * the driver has to ask `portEndpoint(sandboxId, port)` where its bridge is, the one
 * question a `SandboxSession` deliberately cannot answer (`@amond-ai/sandbox`,
 * `SandboxPortEndpoint`), which is what keeps the driver orthogonal to `SANDBOX_BACKEND`
 * instead of knowing which backend it is on.
 */
export function turnDriver(provider: SandboxProvider, run: TurnDriverRun): TurnDriver {
  return sdkTurnDriver({
    provider,
    sandboxId: run.sandboxId,
    config: run.config,
    runId: run.runId,
    openSocket: run.openSocket,
    settingSources: run.settingSources,
  })
}

/** What a driver needs to know about the run it is being built for. */
export interface TurnDriverRun {
  sandboxId: string
  runId: string
  config: TurnDriverConfig
  /**
   * Dial one bridge endpoint URL — the driver's only unstubbable dependency.
   *
   * Passed in rather than built here because opening the socket is the one part that cannot run
   * outside workerd (`sdk-socket.ts` reaches the Cloudflare sandbox binding), and this module has to stay
   * importable from `bun test`. `run-workflow.ts` is workerd-only already, so it passes
   * `turnHostSocketOpener(env)`. `headers` are the endpoint's own, as
   * `SdkTurnDriverInput.openSocket` describes.
   */
  openSocket: (url: string, headers?: Readonly<Record<string, string>>) => Promise<WsLike>
  /**
   * `settingSources` as the driver's `start` frame carries it — which settings files the turn
   * reads is the consumer's policy, injected rather than decided here.
   */
  settingSources: readonly string[]
}
