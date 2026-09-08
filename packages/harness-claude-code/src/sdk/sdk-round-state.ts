import type { TurnTimeoutCause } from '../outcome'
/**
 * What a sequence of frames means: the round's carried state, and the attempt result a terminal
 * frame produces.
 *
 * Import-free, and the reason is the same one `watchdog.ts` gives: this is the part that decides
 * whether a turn is alive, and it has to be readable from `bun test` while the socket that feeds
 * it is not.
 *
 * The state is a Workflow step result, so it is small and JSON-serialisable — `since` is what
 * the next round's `resume` asks for, and `lastActivityAt` is the silence clock carried across
 * the round boundary. Restarting that clock at each round would make a healthy turn immortal:
 * every round would see itself as freshly active.
 */
import type { AttemptResult, TurnSession } from '../turn-driver'
import type { FrameEffect, TerminalObservation } from './sdk-frames'
import { asTurnTimeoutCause } from '../outcome'

/** One round's carried state; `outcome` present exactly when the turn is over. */
export interface TurnRoundState {
  /** The highest `seq` seen — the next round's `resume { lastSeenEventId }`. */
  since: number
  /** Epoch millis of the last frame arrival, carried across rounds. */
  lastActivityAt: number
  /** Set once, by a terminal frame or by a stop the round decided on. */
  outcome?: AttemptResult
  /**
   * The timer that fired, once a round has sent `interrupt` — carried so the next round knows.
   *
   * Across the boundary rather than inside the round, because the interrupt's grace and the
   * window are unrelated lengths: a host that keeps emitting through the grace ends the round on
   * its window with the stop still outstanding, and a round that started fresh would read the
   * host's escalation (`error { phase: 'run' }`) as a turn that failed on its own.
   */
  interruptedBy?: TurnTimeoutCause
  /** Epoch millis of that `interrupt`, which is what the settle deadline is measured from. */
  interruptedAt?: number
}

/**
 * Fold one frame into the round.
 *
 * Every frame that carries a `seq` advances the cursor and resets the silence clock, whatever it
 * says: D4 counts arrival, because a host that is emitting anything at all is a host whose turn
 * has not wedged. A `hello` does neither — it is the handshake, not the turn — and an unreadable
 * frame resets the clock but cannot advance a cursor it could not read.
 */
export function applyFrame(state: TurnRoundState, effect: FrameEffect, now: number): TurnRoundState {
  if (effect.kind === 'hello') {
    return state
  }
  const seq = 'seq' in effect ? effect.seq : undefined
  return {
    ...state,
    since: seq !== undefined && seq > state.since ? seq : state.since,
    lastActivityAt: now,
  }
}

/**
 * The attempt result a terminal frame reports.
 *
 * `interrupted` is a timeout rather than a failure, and it is the *good* ending of one: the host
 * answered `query.interrupt()`, the SDK produced a real `result`, and the transcript ends in the
 * agent's own last word instead of at a signal. `killConfirmed` is `true` because the turn is
 * over by the host's own account — there is nothing left that another attempt could collide with.
 *
 * `deferred` is D6 layer 3: the turn stopped on a tool call a human has to answer, and the
 * request it stopped on rides on the same frame. It is only a deferral when the host named that
 * request — `stopped` says a decision is owed, and an outcome that could not say what it is owed
 * about would park the loop on a question nobody can be asked. A `deferred` finish with no
 * `deferredToolUse` is therefore protocol drift: it is reported as a failure, with a warning, so
 * a host older than the field is visible rather than silently counted as complete.
 *
 * An `error` is a failure whatever its phase — `start` (a refused or invalid start), `init` (the
 * host's own routed-command check) and `run` (the SDK threw, or the interrupt escalation fired).
 * The `run` phase after an interrupt is the one exception, and the round handles it there:
 * that is the host escalating a stop the Worker asked for, not a turn that failed on its own.
 */
export function terminalResult(observation: TerminalObservation): AttemptResult {
  const session = turnSession(observation)
  if (observation.type === 'error') {
    return { outcome: 'failed', ...session }
  }
  switch (observation.stopped) {
    case 'completed':
      return { outcome: 'succeeded', ...session }
    case 'interrupted':
      return { outcome: 'timed-out', killConfirmed: true, ...session }
    case 'deferred':
      return deferredResult(observation, session)
    default:
      return { outcome: 'failed', ...session }
  }
}

/** A deferral the host named a request for, or the drift a nameless one is. */
function deferredResult(
  observation: TerminalObservation & { type: 'finish' },
  session: { session?: TurnSession },
): AttemptResult {
  if (observation.deferredToolUse === undefined) {
    console.warn('turn host reported stopped=deferred with no deferredToolUse; treating as failed')
    return { outcome: 'failed', ...session }
  }
  return { outcome: 'deferred', deferredToolUse: observation.deferredToolUse, ...session }
}

/**
 * The two files this turn leaves behind, lifted off a terminal frame onto the attempt's result
 * (D8).
 *
 * **Both members carry them, and the `error` one is the important case.** A run-phase `error` is
 * the ordinary way a turn fails, which is the ordinary reason the loop retries — so an attempt
 * that failed is precisely the attempt whose session the *next* one wants. What names none is a
 * `start`- or `init`-phase error, which happened before there was a session, a turn that ended
 * before `system`/`init`, and a host older than the field. The key is then omitted rather than
 * set to `undefined`: the result is a Workflow step result, and an absent key is what says "this
 * attempt named no session" to a settle reading it back through JSON.
 *
 * Answered as a spreadable fragment rather than as `TurnSession | undefined` so the arms above
 * stay one expression each; every caller merges it into a result it is already building.
 */
function turnSession(observation: TerminalObservation): { session?: TurnSession } {
  const artifacts = observation.sessionArtifacts
  if (artifacts === undefined) {
    return {}
  }
  return {
    session: {
      sessionId: artifacts.sessionId,
      transcriptPath: artifacts.sessionTranscriptPath,
      journalPath: artifacts.journalPath,
    },
  }
}

/**
 * A terminal observation read in the light of a stop this side asked for.
 *
 * `error { phase: 'run' }` after an `interrupt` is the host's own escalation, not a turn that
 * failed: it aborted the query and is exiting non-zero so this side takes over from a known
 * state. It is therefore reported as the timeout it is, with the timer that started it. Shared
 * by the live settle and by the journal read a gone host is judged from, so the two cannot
 * disagree about what the same frame meant.
 *
 * The cause is the host's own echo where there is one, and `interruptedBy` — this side's memory
 * of the stop it sent, or `inheritedCause`'s inference — only where there is not. That order is
 * the point of #388: the host is the source of truth for what it was *asked*, and it answers on
 * the same frame that reports the ending, while the memory dies with a Workflow step that never
 * commits and the inference cannot read an `error` at all. The memory is now an optimization,
 * and the inference is the fallback for a host older than the field.
 *
 * Only an *interrupted* `finish` is read in that light, though, and a memory of a stop cannot
 * widen it. A `finish` the host called `completed` or `deferred` is positive evidence the
 * `interrupt` never landed — it reaches the runtime only while a turn is running, and a host
 * that had already settled answers on the socket instead — so a remembered cause there would
 * record a turn that succeeded as a timeout, or turn a deferral into one and drop the request it
 * is waiting on.
 */
export function observedResult(
  observation: TerminalObservation,
  interruptedBy: TurnTimeoutCause | undefined,
): AttemptResult {
  // An echo the host did send is the whole answer, even when it names a reason this side has no
  // timeout for: the host acts on the first `interrupt` only, so an `operator` echo beside a
  // remembered timer means the timer's stop was the no-op, and the memory is the stale reading.
  const echoed = observation.interruptedBy
  // `asTurnTimeoutCause` is the narrowing, because `InterruptReason` is one value wider than
  // `TurnTimeoutCause`: `operator` is a human stopping a turn, not a timer firing, and would be
  // a lie as `timedOutBy` — the field says *which deadline* ended the turn, and
  // `shouldStopAttemptLoop` and the run vocabulary read it that way. The `undefined` it answers
  // there is an answer rather than a miss: the host did echo, so the ending settles on what the
  // frame itself says rather than on a stale memory. An operator stop needs an outcome of its
  // own before it can be reported as one.
  const cause = echoed === undefined ? interruptedBy : asTurnTimeoutCause(echoed)
  const interrupted = observation.type === 'finish' && observation.stopped === 'interrupted'
  const escalated = observation.type === 'error' && observation.phase === 'run'
  if (cause === undefined || !(escalated || interrupted)) {
    return terminalResult(observation)
  }
  // The artifacts still travel: a stop this side asked for is answered by a `finish` — or, when
  // the host escalated it, by a run-phase `error` — and both name the same two paths any other
  // ending reports. The next attempt's resume needs them exactly as much, arguably more, since
  // an interrupted turn left work unfinished.
  return { ...interruptedResult(cause, true), ...turnSession(observation) }
}

/** The same, for a stop this Worker decided on: the timer that fired is what it is named by. */
export function interruptedResult(timedOutBy: TurnTimeoutCause, killConfirmed: boolean): AttemptResult {
  return { outcome: 'timed-out', killConfirmed, timedOutBy }
}

/**
 * Whether the whole turn is over, as `live-mirror`'s `complete` stamp asks it.
 *
 * The same question `cli-turn-watch.ts` answers, with one deliberate difference. There, a
 * `failed` attempt carrying no exit code is *not* proof the process stopped — the reading came
 * from a wait that ended without one. Here it is: a `failed` outcome exists only because the
 * host sent `finish` or `error`, which is the host's own account of a turn that is over. The
 * one case that stays unproven is the same one — a timeout whose kill went unconfirmed, where
 * the process may still be writing more than the snapshot holds.
 */
export function roundEnded(outcome: AttemptResult | undefined): boolean {
  if (outcome === undefined) {
    return false
  }
  if (outcome.exitCode !== undefined || outcome.outcome === 'succeeded') {
    return true
  }
  return outcome.outcome === 'timed-out' ? outcome.killConfirmed : true
}
