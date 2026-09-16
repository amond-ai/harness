/**
 * Starting one turn on the `sdk` driver: exec the host, wait for it to bind, connect, `start`.
 *
 * Four things happen here that do not happen on the `cli` path, and each is forced by the
 * bridge's own shape. The prompt travels in a frame rather than in argv, so it never appears in
 * `listProcesses()`. The host must be *listening* before anything can be said to it, and `await
 * exec` only means the process started. A `start` is refused by a bridge that already has a turn
 * running, which is what makes an adopted host safe to re-enter. And the socket is closed again
 * as soon as `start` is acknowledged — the rounds each open their own, and a socket held across
 * a step boundary is a socket the Workflow cannot persist.
 */
import type { ApprovedRequest, DeniedRequest } from '@amond-ai/harness-protocol/claude-code'
import type { WsLike } from '@amond-ai/harness-transport'
import type { SandboxProcessHandle } from '@amond-ai/sandbox'
import type { PermissionMode } from '../permission-mode'
import type { TurnHandle } from '../turn-driver'
import type { TurnChannel } from './sdk-channel'
import { describeCause as describe } from '@amond-ai/redact'
import { INTERRUPT_SETTLE_TIMEOUT_MS } from '../cli-turn-kill'
import { iterateStream } from '../process-ndjson'
import { readBridgeAnnouncement } from './sdk-bridge-config'
import { createTurnChannel } from './sdk-channel'
import { classifyFrame } from './sdk-frames'

/**
 * How long the host has to bind its socket and announce it.
 *
 * Generous because a cold container's first `node` start is slow, and bounded because the
 * alternative to a bound is a `start-turn` step that hangs until the platform aborts it — the
 * one ending with no diagnosis at all.
 */
export const BRIDGE_READY_TIMEOUT_MS = 120_000

/** How often the stdout cursor is re-read while waiting for that announcement. */
const READY_POLL_INTERVAL_MS = 250

export interface SdkStartInput {
  process: SandboxProcessHandle
  connect: () => Promise<WsLike>
  prompt: string
  permissionMode: PermissionMode
  /**
   * Which settings files the turn reads, as the consumer names them — the same list the `cli`
   * argv passes to `--setting-sources`, injected for the reason `TurnDriverRun.settingSources`
   * states.
   */
  settingSources: readonly string[]
  /**
   * The org posture the host appends to the Claude Code preset system prompt.
   *
   * Text rather than a composed system prompt, because the host owns that shape: it wraps this in
   * `{ type: 'preset', preset: 'claude_code', append }`, so the preset the CLI would have used is
   * kept and this rides after it. Absent on a turn the caller gave none.
   */
  instructions?: string
  /** The deployment's per-run ceilings, when it set any; the driver reads them off its config. */
  limits?: { maxBudgetUsd?: number, maxTurns?: number }
  startedAtMs: number
  port: number
  token: string
  stateDir: string
  /**
   * The session this turn continues, as the id the SDK resumes by (ADR D8).
   *
   * The id alone: the file it names is already in the container by the time this resolves —
   * the workflow's restore put it there, or found it still present — and the SDK locates it
   * itself. Resolves to nothing for a fresh turn, which is every first attempt.
   *
   * A thunk, and asked only at the moment a `start` is really sent: an adopted host that is
   * still waiting is one whose container the restart has not looked into, so the check runs
   * then, against the container the live host proves is still the same one. Resolving it
   * earlier would answer for a host that turns out to need no `start` at all.
   */
  resume?: () => Promise<string | undefined>
  /**
   * The id a *fresh* turn runs under — the run's own, minted by the Agent before any turn.
   *
   * Mutually exclusive with {@link SdkStartInput.resume}, which is the SDK's own rule about the
   * two options; the driver sends whichever applies and never both. Present without `resume`
   * whenever the session file could not be found or put back: the turn then starts a new
   * conversation, but under the name the run already mirrors and resumes by, so the *next*
   * attempt has something to continue.
   */
  sessionId?: string
  /**
   * The run's permission posture, as this deployment configured it (D6 layers 1 and 3).
   *
   * Empty lists are omitted rather than sent, on {@link SdkStartInput.limits}'s discipline: a
   * deployment that defers nothing says nothing at all about deferring.
   */
  policy?: { refuseTools?: readonly string[], deferTools?: readonly string[] }
  /** The one-shot answers a human gave, for the attempt that resumes to hear them (D6). */
  approvedRequests?: readonly ApprovedRequest[]
  deniedRequests?: readonly DeniedRequest[]
}

/**
 * Wait for `bridge-ready`, then hand the host its turn.
 *
 * A `bridge-fatal` is raised as the failure it is rather than waited past: a host with no
 * channel token, or one whose port is taken, prints it and exits within milliseconds, and
 * spending the whole readiness budget on it would replace a named cause with a timeout.
 *
 * The `start` is not merely sent — it is *acknowledged* before the handle exists. `send` only
 * hands the frame to the socket, and every later round says `resume` and never `start`, so a
 * frame the host never processed would leave the attempt attached to a host that is doing
 * nothing until the budget kills a turn that never began. Failing here instead fails
 * `start-turn-N`, where the attempt loop can still start another turn.
 */
export async function startTurnHost(input: SdkStartInput): Promise<TurnHandle> {
  await awaitBridgeReady(input.process)
  return await handTurnToHost({ ...input, processId: input.process.id })
}

/** {@link SdkStartInput} for a host that is already listening — an adopted one has no handle. */
export type SdkHandOffInput = Omit<SdkStartInput, 'process'> & { processId: string }

/**
 * Connect to a listening host and make sure it holds this turn.
 *
 * The `start` is sent only to a host that has never been given one — and the greeting's
 * *cursor*, not its state, is what says so. The bridge returns to `waiting` once a turn ends,
 * so a short turn that finished before this step's result committed greets a re-entry exactly
 * like a host that was never started; a second `start` there would clear its journal and run
 * the prompt again. But every frame the bridge ever emitted advanced `lastSeq`, the very first
 * being the `bridge-started` it answers a `start` with, so a cursor at zero is a host nothing
 * has happened to. A host already `running` was given its turn by an earlier entry into this
 * step, and the bridge refuses a second `start` anyway. The gap this closes is the restart
 * between `exec` and the acknowledgement: that host is live, so the adoption guard finds it,
 * but it is still waiting, and a round only ever sends `resume`.
 */
export async function handTurnToHost(input: SdkHandOffInput): Promise<TurnHandle> {
  const channel = createTurnChannel(await input.connect())
  try {
    const hello = await channel.next(INTERRUPT_SETTLE_TIMEOUT_MS)
    const greeting = 'frame' in hello ? classifyFrame(hello.frame) : undefined
    if (greeting?.kind !== 'hello') {
      throw new Error(`turn host did not greet the connection process_id=${input.processId}`)
    }
    if (greeting.state !== 'running' && (greeting.lastSeq ?? 0) === 0) {
      channel.send(startFrame(input, await input.resume?.()))
      await awaitStartAck(channel, input.processId)
    }
  }
  finally {
    channel.close()
  }
  return {
    processId: input.processId,
    startedAtMs: input.startedAtMs,
    port: input.port,
    token: input.token,
    bridgeStateDir: input.stateDir,
  }
}

/**
 * Wait for the host's first frame of the turn, which is what proves it took the `start`.
 *
 * Any frame with a `seq` will do, and that is not a shortcut: the bridge journals every outbound
 * frame before it sends it and stamps the sequence there, so a `seq` is the host's own record of
 * having acted. The first one may be a `raw` message, a `sandbox-log` or an `error` — this only
 * asks whether the host answered, not what it said; a turn that fails immediately is the round's
 * to read from the journal.
 *
 * Bounded by the interrupt settle, the same grace this side gives the host everywhere else. A
 * deadline or a closed socket is the failure, because both mean the same thing: nothing came
 * back, and a handle returned on that promises a turn that is not running.
 */
async function awaitStartAck(channel: TurnChannel, processId: string): Promise<void> {
  // The host answers `bridge-started` as soon as it enters `running` — before `query()` has said
  // anything — so the bound below is measured against the bridge, not against a cold model.

  const answer = await channel.next(INTERRUPT_SETTLE_TIMEOUT_MS)
  if (!('frame' in answer)) {
    throw new Error(`turn host did not acknowledge start process_id=${processId} reason=${answer.end}`)
  }
  const effect = classifyFrame(answer.frame)
  if (effect.kind === 'hello') {
    throw new Error(`turn host did not acknowledge start process_id=${processId} reason=greeting`)
  }
}

/**
 * The `start` frame.
 *
 * `permissionMode` passes straight through: `PERMISSION_MODES` in `env.ts` and the host's
 * `sdkPermissionModeSchema` are the same six names, so there is no mapping to get wrong and no
 * Worker-only mode to translate. `settingSources` is the same list the `cli` argv names, for the
 * same reasons stated there — passed in by the consumer rather than decided here.
 *
 * `approvalPolicy: 'deny'` is D6 layer 1, and it is the only posture a headless turn can take:
 * `canUseTool` may pend indefinitely, and a turn waiting on a human who is not there never ends.
 * `emitDeltas: false` because a six-hour turn at one frame per token would spend the per-step
 * CPU meter on JSON parsing; liveness comes from complete messages and `tool_progress` instead.
 * `persistSession: true` so the session file exists for D8's preservation, which is phase 4 —
 * this stage records the paths the host reports and does nothing else with them.
 *
 * `maxBudgetUsd` and `maxTurns` ride along **only when the deployment named one**
 * (`TURN_MAX_BUDGET_USD`, `TURN_MAX_TURNS`). The keys are omitted rather than sent as `undefined`
 * so an unlimited turn says nothing at all about limits, and so the host's schema — where both
 * are optional — reads the same thing this side means. They are worth sending at all because a
 * limit the SDK enforces ends the turn with a typed subtype and a transcript, which is precisely
 * what the Worker's wall-clock kill cannot produce (D5).
 *
 * `resume` rides along **only when the workflow resolved a session to continue** (D8), with the
 * same absent-key discipline as the limits: a fresh turn says nothing at all about resuming,
 * rather than sending `undefined` for a field the host's schema declares optional. The workflow
 * sets it only after the restore step confirmed the session file is in the container, because a
 * `resume` of a session whose transcript is missing starts a fresh one while every reader
 * believes the context carried over.
 *
 * `refuseTools` / `deferTools` carry the run's permission posture (D6). `deferTools` is what
 * makes layer 3 exist at all: a matching call ends the turn with `terminal_reason:
 * 'tool_deferred'` instead of running, and the attempt loop then waits for a human. The
 * `approvedRequests` / `deniedRequests` beside them are that human's answer, replayed into the
 * attempt that resumes — one entry, consumed once by the host, because an answer authorizes one
 * request rather than the tool. All four are omitted when empty, so a deployment with no policy
 * sends a frame that says nothing about one.
 *
 * `sessionId` is the run's own id on a turn that is *not* resuming, and it is why the Worker
 * mints one at all (`TurnStartSpec.sessionId`): a fresh turn under a known name leaves a session
 * the next attempt can ask for, where a turn that let the SDK name itself would leave one only
 * this workflow instance ever knew about. It is never sent beside `resume` — the SDK documents
 * the two as mutually exclusive, and the caller decides which applies.
 *
 * `pathToClaudeCodeExecutable` is still absent — `docker/config.toml` installs the CLI through
 * mise's shims on `PATH` rather than at a path pinned anywhere, so naming one here would be
 * inventing a fact the image does not state.
 *
 * `instructions` follows the same absent-key discipline as everything above: a turn given no
 * posture says nothing about one, rather than sending `undefined` for a field the host's schema
 * declares optional.
 */
function startFrame(input: SdkHandOffInput, resume: string | undefined): Record<string, unknown> {
  return {
    type: 'start',
    prompt: input.prompt,
    settingSources: [...input.settingSources],
    permissionMode: input.permissionMode,
    persistSession: true,
    approvalPolicy: 'deny',
    emitDeltas: false,
    ...(input.instructions === undefined ? {} : { instructions: input.instructions }),
    // The host's grace for `query.interrupt()` to produce a `result`, set to this side's own
    // interrupt settle so the two ladders agree: the host escalates at the moment the Worker
    // stops expecting a `finish`, rather than 15 s after it (the host's own default is 30 s).
    interruptGraceMs: INTERRUPT_SETTLE_TIMEOUT_MS,
    ...(input.limits?.maxBudgetUsd === undefined ? {} : { maxBudgetUsd: input.limits.maxBudgetUsd }),
    ...(input.limits?.maxTurns === undefined ? {} : { maxTurns: input.limits.maxTurns }),
    ...(resume === undefined
      ? (input.sessionId === undefined ? {} : { sessionId: input.sessionId })
      : { resume }),
    ...listField('refuseTools', input.policy?.refuseTools),
    ...listField('deferTools', input.policy?.deferTools),
    ...listField('approvedRequests', input.approvedRequests),
    ...listField('deniedRequests', input.deniedRequests),
  }
}

/**
 * One optional list field, present only when it has entries.
 *
 * The absent-key discipline the limits already follow, applied to the four policy lists: an
 * empty array on the wire would say "this run refuses nothing" in a frame that could equally
 * have said nothing at all, and the host's schema reads both the same way anyway.
 */
function listField(
  name: string,
  values: readonly unknown[] | undefined,
): Record<string, readonly unknown[]> {
  return values === undefined || values.length === 0 ? {} : { [name]: values }
}

/**
 * Read the host's stdout until it says it is listening.
 *
 * Through the process log cursor rather than a connect-retry loop, because the two failures look
 * identical from a socket and completely different in the log: a host still booting and a host
 * that died at `bridge-fatal` both refuse a connection, and only the log says which.
 */
async function awaitBridgeReady(process: SandboxProcessHandle): Promise<void> {
  const deadline = Date.now() + BRIDGE_READY_TIMEOUT_MS
  let since: string | undefined
  let text = ''
  // One decoder for the whole wait, not one per poll: the announcement is ASCII, but anything
  // else the host prints need not be, and a multi-byte character split across two cursor batches
  // only survives if the same streaming decoder sees both halves.
  const decoder = new TextDecoder()
  for (;;) {
    const batch = await readStdout(process, since, decoder)
    since = batch.cursor ?? since
    text += batch.text
    const announcement = readBridgeAnnouncement(text)
    if (announcement?.status === 'ready') {
      return
    }
    if (announcement?.status === 'fatal') {
      throw new Error(`turn host refused to start: ${announcement.message}`)
    }
    if (Date.now() >= deadline) {
      throw new Error(`turn host did not announce a listening socket within ${String(BRIDGE_READY_TIMEOUT_MS)}ms`)
    }
    await new Promise(resolve => setTimeout(resolve, READY_POLL_INTERVAL_MS))
  }
}

/** One cursor batch of the host's stdout, and where the next read resumes from. */
async function readStdout(
  process: SandboxProcessHandle,
  since: string | undefined,
  decoder: TextDecoder,
): Promise<{ text: string, cursor: string | undefined }> {
  try {
    const logs = await process.logs({ since, replay: true, follow: false })
    let text = ''
    let cursor = since
    for await (const event of iterateStream(logs)) {
      cursor = event.cursor ?? cursor
      if (event.type === 'stdout' && event.data) {
        text += decoder.decode(event.data, { stream: true })
      }
    }
    return { text, cursor }
  }
  catch (cause) {
    // A read that failed is not an announcement that will not come; the deadline decides.
    console.warn(`turn host readiness read failed process_id=${process.id} error="${describe(cause)}"`)
    return { text: '', cursor: since }
  }
}
