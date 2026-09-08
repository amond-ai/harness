/**
 * One `HarnessV1` session over the `sdk` driver: a turn is started once and then consumed one
 * bounded attach round at a time, exactly as the attempt loop consumes it.
 *
 * The rounds loop runs *beside* `doPromptTurn` rather than inside it. The contract is that
 * `doPromptTurn` resolves with a control handle while the turn is still running and that
 * `control.done` resolves when it ends, which is the same shape the driver already has — a round
 * is a bounded window, and the loop over windows is what a turn is.
 *
 * `doSuspendTurn` is the reason {@link TurnRoundSpec.signal} exists. The round boundary is the
 * driver's to choose until a caller wants to choose it, and a suspend is a window expiry on
 * somebody else's timer: the host keeps running, the state carries the cursor, and the next
 * slice attaches from it. Nothing is interrupted and nothing is killed, so a suspend costs the
 * turn nothing but a socket.
 */
import type {
  HarnessV1ContinueTurnState,
  HarnessV1Prompt,
  HarnessV1PromptControl,
  HarnessV1ResumeSessionState,
  HarnessV1Session,
  HarnessV1StreamPart,
} from '@ai-sdk/harness'
import type { TurnHostOutboundMessage } from '@amond-ai/harness-protocol'
import type { SandboxProvider } from '@amond-ai/sandbox'
import type { TurnDriverConfig } from '../config'
import type { LiveMirror } from '../mirror'
import type { PermissionMode } from '../permission-mode'
import type { AttemptResult, TurnDriver, TurnHandle, TurnResume, TurnRoundState, TurnSession } from '../turn-driver'
import type { TurnEnding } from './frame-to-part'
import type { ClaudeCodeLifecycleState, ClaudeCodeRoundCursor, ClaudeCodeTurnHandle } from './lifecycle-state'
import { HarnessCapabilityUnsupportedError } from '@ai-sdk/harness'
import { clampedTurnBudget, maxAttachRounds } from '../watchdog'
import { frameToPart } from './frame-to-part'

export interface ClaudeCodeSessionInput {
  driver: TurnDriver & { mode: 'rounds' }
  /** The provider, resolved per use like the driver does: a session stub does not outlive a step. */
  sandboxes: SandboxProvider
  harnessId: string
  sessionId: string
  sandboxId: string
  config: TurnDriverConfig
  permissionMode: PermissionMode
  env: () => Record<string, string>
  /** Where the turn runs — the framework composed it under the sandbox's own default. */
  workDir: string
  mirror?: (turn: { sessionId: string, attempt: number }) => LiveMirror | undefined
  /** What this session was started from: fresh, resumed, or holding a suspended turn. */
  state: ClaudeCodeLifecycleState
  isResume: boolean
  /** Whether a `continueFrom` started it, which is what `doContinueTurn` requires. */
  continuing: boolean
}

/** The turn currently in flight, and the two ways it can be asked to stop. */
interface ActiveTurn {
  /** Ends the rounds loop; a suspend by default, an abort when {@link ActiveTurn.aborted} is set. */
  suspend: AbortController
  aborted: boolean
  done: Promise<void>
}

export function createClaudeCodeSession(input: ClaudeCodeSessionInput): HarnessV1Session {
  let handle = input.state.handle as TurnHandle | undefined
  let cursor = input.state.round
  let session = input.state.session as TurnSession | undefined
  let active: ActiveTurn | undefined
  let endedBy: string | undefined
  // Whether the host behind `handle` may still be running a turn: set by a start and by a
  // `continueFrom` (the suspended turn is live by definition), cleared when the loop sees the
  // turn end. A stop or a destroy that finds no local loop still has to kill that host.
  let turnOpen = input.continuing && handle !== undefined

  const unsupported = (message: string): HarnessCapabilityUnsupportedError =>
    new HarnessCapabilityUnsupportedError({ harnessId: input.harnessId, message })

  /** After a suspend, a detach or a stop this instance is spent: the contract says so. */
  const usable = (): void => {
    if (endedBy !== undefined) {
      throw new Error(`claude-code session ${input.sessionId} is unusable after ${endedBy}`)
    }
  }

  const remember = (frame: TurnHostOutboundMessage, emit: (part: HarnessV1StreamPart) => void): boolean => {
    const { part, sessionArtifacts, ending } = frameToPart(frame)
    if (sessionArtifacts !== undefined) {
      session = {
        ...(sessionArtifacts.sessionId === undefined ? {} : { sessionId: sessionArtifacts.sessionId }),
        ...(sessionArtifacts.sessionTranscriptPath === undefined
          ? {}
          : { transcriptPath: sessionArtifacts.sessionTranscriptPath }),
        journalPath: sessionArtifacts.journalPath,
      }
    }
    if (part === undefined) {
      return false
    }
    // A `finish` the host did not narrate as a *completion* is not one. The contract's schema
    // strips `stopped`, `interruptedBy` and `deferredToolUse`, and the host hardcodes
    // `finishReason: 'stop'` on every ending — so emitting the stripped part as-is would hand
    // `HarnessAgent` a clean completion for a turn the watchdog cut off or an approval parked,
    // and the `terminal` flag below would then suppress `outcomeError`, the only other signal.
    if (part.type === 'finish' && ending !== undefined && ending.reason !== 'completed') {
      emit({ type: 'error', error: new Error(endingMessage(ending)) })
      return true
    }
    emit(part)
    return part.type === 'finish' || part.type === 'error'
  }

  /**
   * Consume rounds until the turn ends, the caller takes it back, or the rounds run out.
   *
   * The round count is the attempt loop's own — `maxAttachRounds` covers the wall-clock budget
   * with two rounds to spare — and it is *absolute* rather than per slice, so a turn that
   * suspends and continues does not re-spend the whole allowance each time it resumes.
   *
   * The mirror is resolved once for the turn, not once per round: `create-claude-code.ts` types
   * the factory as per-turn and keys it `{ sessionId, attempt }`, both invariant across rounds,
   * so calling it inside the loop would hand each round a sink the consumer never expected to
   * build twice — an unseeded one would republish only its own round over the turn's record.
   */
  const consume = async (
    turn: ActiveTurn,
    live: TurnHandle,
    from: number,
    emit: (part: HarnessV1StreamPart) => void,
  ): Promise<void> => {
    const cap = maxAttachRounds(clampedTurnBudget(input.config.turnWallClockBudgetMs))
    const mirror = input.mirror?.({ sessionId: input.sessionId, attempt: input.state.attempt })
    let terminal = false
    for (let round = from; round <= cap; round += 1) {
      const state = await input.driver.awaitRound(live, {
        config: input.config,
        mirror,
        round,
        previous: previousRound(cursor),
        signal: turn.suspend.signal,
        onFrame: (frame) => {
          terminal = remember(frame, emit) || terminal
        },
      })
      cursor = { ...roundCursor(state), round }
      if (state.outcome !== undefined) {
        // Every ending the host *narrated* has already reached `emit` as a `finish` or an
        // `error`. The ones it did not — a timeout, a kill, a host found gone — would otherwise
        // leave `HarnessAgent` with a stream that simply stopped, so they are named here.
        turnOpen = false
        if (!terminal) {
          emit(outcomeError(state.outcome))
        }
        return
      }
      if (turn.aborted) {
        turnOpen = false
        await input.driver.kill(live)
        emit({ type: 'error', error: new Error(`claude-code turn aborted by the caller`) })
        return
      }
      if (turn.suspend.signal.aborted) {
        // Suspended: the host is still running and the cursor above is what the next slice
        // attaches from, so this turn is emphatically not over and gets no terminal part.
        return
      }
    }
    turnOpen = false
    await input.driver.kill(live)
    emit({ type: 'error', error: new Error(`claude-code turn ran out of attach rounds after ${String(cap)}`) })
  }

  /** Start the rounds loop beside the caller, and hand back the control it drives the turn by. */
  const drive = (
    live: TurnHandle,
    from: number,
    emit: (part: HarnessV1StreamPart) => void,
    abortSignal: AbortSignal | undefined,
  ): HarnessV1PromptControl => {
    const turn: ActiveTurn = { suspend: new AbortController(), aborted: false, done: Promise.resolve() }
    const onAbort = (): void => {
      turn.aborted = true
      turn.suspend.abort()
    }
    // A signal that is already aborted never fires its listener, and the caller may have aborted
    // while `driver.start` was still waiting on bridge readiness.
    if (abortSignal?.aborted) {
      onAbort()
    }
    else {
      abortSignal?.addEventListener('abort', onAbort, { once: true })
    }
    turn.done = (async () => {
      try {
        await consume(turn, live, from, emit)
      }
      catch (cause) {
        // `done` resolves rather than rejects on every path: the loop is the adapter's own, and a
        // failure in it is a turn that ended badly — which the contract expresses as a part. The
        // host is killed first: left running, the next prompt's `start` would adopt it as a live
        // host with the same argv and hand the new prompt to a turn that never receives it.
        turnOpen = false
        await input.driver.kill(live).catch(() => false)
        emit({ type: 'error', error: cause })
      }
      finally {
        abortSignal?.removeEventListener('abort', onAbort)
        active = undefined
      }
    })()
    active = turn
    return {
      done: turn.done,
      submitToolResult: async () => {
        throw unsupported('The claude-code harness does not accept host-executed tool results: the turn host runs the Agent SDK\'s own tools.')
      },
    }
  }

  const lifecycleData = (): HarnessV1ContinueTurnState['data'] => ({
    sandboxId: input.sandboxId,
    ...(handle === undefined ? {} : { handle: exportedHandle(handle) }),
    ...(cursor === undefined ? {} : { round: cursor }),
    ...(session === undefined ? {} : { session }),
    attempt: input.state.attempt,
  } satisfies ClaudeCodeLifecycleState as unknown as HarnessV1ContinueTurnState['data'])

  const resumeState = (): HarnessV1ResumeSessionState => ({
    type: 'resume-session',
    harnessId: input.harnessId,
    specificationVersion: 'harness-v1',
    // The handle and the cursor are deliberately dropped: a session handed back between turns
    // has no turn to attach to, and a stale handle would invite the next start to dial a host
    // that is no longer running this conversation.
    data: { sandboxId: input.sandboxId, ...(session === undefined ? {} : { session }), attempt: input.state.attempt } satisfies ClaudeCodeLifecycleState as unknown as HarnessV1ContinueTurnState['data'],
  })

  return {
    sessionId: input.sessionId,
    isResume: input.isResume,

    async doPromptTurn({ prompt, instructions, abortSignal, emit }) {
      usable()
      const text = promptText(prompt, input.harnessId)
      const resume = resumeThunk(input, session)
      handle = await input.driver.start({
        prompt: text,
        permissionMode: input.permissionMode,
        ...(instructions === undefined ? {} : { instructions }),
        attempt: input.state.attempt,
        cwd: input.workDir,
        env: input.env,
        recordedProcessId: undefined,
        started: [],
        // The conversation this session already has, when a `resumeFrom` named one. `resume`
        // restores its transcript when the file is still in this container; `sessionId` is what
        // the host falls back to when it is not — a fresh turn under the same id, so what it
        // leaves behind stays one session. The driver sends whichever applies, never both.
        ...(session?.sessionId === undefined ? {} : { sessionId: session.sessionId }),
        ...(resume === undefined ? {} : { resume }),
        policy: { deferTools: input.config.turnDeferTools, refuseTools: input.config.turnRefuseTools },
      })
      cursor = undefined
      turnOpen = true
      return drive(handle, 1, emit, abortSignal)
    },

    async doContinueTurn({ abortSignal, emit }) {
      usable()
      if (!input.continuing || handle === undefined) {
        throw new Error(`claude-code session ${input.sessionId} has no suspended turn to continue: start it with continueFrom`)
      }
      return drive(handle, (cursor?.round ?? 0) + 1, emit, abortSignal)
    },

    async doSuspendTurn() {
      usable()
      const turn = active
      if (turn === undefined) {
        throw new Error(`claude-code session ${input.sessionId} has no turn in flight to suspend`)
      }
      turn.suspend.abort()
      await turn.done
      // The host now belongs to the continue state this returns, so a `doDestroy` on this spent
      // instance must not kill what the next slice is about to attach to.
      turnOpen = false
      endedBy = 'doSuspendTurn'
      return {
        type: 'continue-turn',
        harnessId: input.harnessId,
        specificationVersion: 'harness-v1',
        data: lifecycleData(),
      }
    },

    async doDetach() {
      usable()
      endedBy = 'doDetach'
      return resumeState()
    },

    async doStop() {
      usable()
      // `HarnessAgent` suspends an active turn before it stops a session, so a live turn here is
      // a caller that did not — and a host left running would hold this attempt's port.
      await stopActive({ active, handle, turnOpen, driver: input.driver })
      turnOpen = false
      endedBy = 'doStop'
      return resumeState()
    },

    async doDestroy() {
      await stopActive({ active, handle, turnOpen, driver: input.driver })
      turnOpen = false
      endedBy = 'doDestroy'
      // The sandbox itself is never touched: the contract reserves that for the provider.
    },

    async doCompact() {
      throw unsupported('The claude-code harness cannot compact on request: the Agent SDK compacts its own context.')
    },
  }
}

/**
 * End a turn that is still running, for the two lifecycle methods that must not leave one.
 *
 * Two shapes of "running": a loop this instance is driving, and a host a `continueFrom` handed
 * over that nobody has continued yet. The second has no local loop to end, but it is the more
 * important kill — the caller is discarding the only state that can reach that host.
 */
async function stopActive(turn: {
  active: ActiveTurn | undefined
  handle: TurnHandle | undefined
  turnOpen: boolean
  driver: TurnDriver & { mode: 'rounds' }
}): Promise<void> {
  const { active, handle, turnOpen, driver } = turn
  if (active !== undefined) {
    active.aborted = true
    active.suspend.abort()
    await active.done
  }
  else if (!turnOpen) {
    return
  }
  if (handle !== undefined) {
    await driver.kill(handle)
  }
}

/**
 * The session to continue, as the driver's exec-path thunk — or nothing, when there is nothing.
 *
 * Answered on the exec path and not before, for the reason `TurnStartSpec.resume` gives: whether
 * the transcript is in *this* container is not a durable fact. A `resume` sent without it makes
 * the SDK start a new session under the old id in silence, so the check and the frame are one
 * step, and a missing file falls back to `sessionId` — an honest fresh start under the same name.
 */
function resumeThunk(
  input: Pick<ClaudeCodeSessionInput, 'sandboxes' | 'sandboxId'>,
  session: TurnSession | undefined,
): (() => Promise<TurnResume | undefined>) | undefined {
  const sessionId = session?.sessionId
  const transcriptPath = session?.transcriptPath
  if (sessionId === undefined || transcriptPath === undefined) {
    return undefined
  }
  return async () => {
    // The contract for this thunk is that it never rejects: a failed check and a missing file
    // both mean "not in this container", and the turn starts fresh under the same id. Each spends
    // one line of diagnostics, because from the outside a fresh start under the old id looks
    // exactly like a resume — only the agent's forgotten context would say otherwise.
    try {
      const { exists } = await input.sandboxes.session(input.sandboxId).exists(transcriptPath)
      if (exists) {
        return { sessionId, transcriptPath }
      }
      console.warn(`claude-code session not resumed session_id=${sessionId} reason="transcript not in the container"`)
    }
    catch (cause) {
      console.warn(`claude-code session not resumed session_id=${sessionId} reason="${cause instanceof Error ? cause.message : String(cause)}"`)
    }
    return undefined
  }
}

/** The state a round resumes from — the cursor without the round counter it is stored with. */
/**
 * The handle as the schema exports it: every field present, or nothing exported at all.
 *
 * The sdk driver never makes a handle without them, so a missing one here is a driver from
 * somewhere else — and a continuation that dials nothing is worse than a suspend that refuses.
 */
function exportedHandle(handle: TurnHandle): ClaudeCodeTurnHandle {
  const { processId, startedAtMs, port, token, bridgeStateDir } = handle
  if (startedAtMs === undefined || port === undefined || token === undefined || bridgeStateDir === undefined) {
    throw new Error(`claude-code turn handle process_id=${processId} is missing its bridge fields and cannot be suspended`)
  }
  return { processId, startedAtMs, port, token, bridgeStateDir }
}

function previousRound(cursor: ClaudeCodeRoundCursor | undefined): TurnRoundState | undefined {
  if (cursor === undefined) {
    return undefined
  }
  return {
    since: cursor.since,
    lastActivityAt: cursor.lastActivityAt,
    ...(cursor.interruptedBy === undefined ? {} : { interruptedBy: cursor.interruptedBy }),
    ...(cursor.interruptedAt === undefined ? {} : { interruptedAt: cursor.interruptedAt }),
  }
}

/** The round's state as it is stored: no `outcome`, because a stored state is a live turn. */
function roundCursor(state: TurnRoundState): Omit<ClaudeCodeRoundCursor, 'round'> {
  return {
    since: state.since,
    lastActivityAt: state.lastActivityAt,
    ...(state.interruptedBy === undefined ? {} : { interruptedBy: state.interruptedBy }),
    ...(state.interruptedAt === undefined ? {} : { interruptedAt: state.interruptedAt }),
  }
}

/** The terminal part an ending the host never narrated is reported as. */
function outcomeError(outcome: AttemptResult): HarnessV1StreamPart {
  const cause = outcome.outcome === 'timed-out' && outcome.timedOutBy !== undefined
    ? `${outcome.outcome} (${outcome.timedOutBy})`
    : outcome.outcome
  return { type: 'error', error: new Error(`claude-code turn ended without a host frame: ${cause}`) }
}

/**
 * How a `finish` the host did *not* call a completion is worded to the consumer.
 *
 * Everything the strip removed is named here, because that is the whole point of keeping it: the
 * timer for an interrupt, and the tool call for a `deferred` turn — without the latter a caller
 * cannot tell which approval the turn is parked on, and the request is unrecoverable from the
 * stream.
 */
function endingMessage(ending: TurnEnding): string {
  const timer = ending.interruptedBy === undefined ? '' : ` (${ending.interruptedBy})`
  const deferred = ending.deferredToolUse === undefined
    ? ''
    : `, awaiting approval of tool use ${ending.deferredToolUse.id} (${ending.deferredToolUse.name})`
  return `claude-code turn stopped: ${ending.reason}${timer}${deferred}`
}

/**
 * The turn's prompt as the host takes it: text.
 *
 * The same rule the reference adapter states — the bridge's `start` frame carries a string, so a
 * part this cannot render is refused rather than dropped, which would run a turn on a prompt the
 * caller did not write.
 */
function promptText(prompt: HarnessV1Prompt, harnessId: string): string {
  if (typeof prompt === 'string') {
    return prompt
  }
  const content = prompt.content
  if (typeof content === 'string') {
    return content
  }
  return content.map((part) => {
    if (part.type !== 'text') {
      throw new HarnessCapabilityUnsupportedError({
        harnessId,
        message: `The claude-code harness does not support user message parts of type '${part.type}'. Pass a string, or a user message whose content is only text parts.`,
      })
    }
    return part.text
  }).join('')
}
