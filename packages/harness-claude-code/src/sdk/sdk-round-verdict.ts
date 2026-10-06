/**
 * The budget and cause helpers of an attach round, moved out of `sdk-round.ts` (the file
 * had grown past the 500-line limit).
 *
 * What the round says about a turn that ended or timed out — which timer fired, whether a spent
 * budget outranks the host's own echo, and how a turn that cannot be reached or is gone is read.
 */
import type { TurnTimeoutCause, TurnVerdict } from '../outcome'
import type { AttemptResult } from '../turn-driver'
import type { TerminalObservation } from './sdk-frames'
import type { AttachRoundInput, PumpContext } from './sdk-round'
import { killTurn } from '../cli-turn-kill'
import { withVerdict } from '../turn-result-scan'
import { turnBudgetExhausted, turnTimeoutCause } from '../watchdog'
import { readJournalEnding } from './sdk-journal'
import { interruptedResult, observedResult } from './sdk-round-state'

/**
 * A spent budget outranks a `watchdog` cause, whoever named it.
 *
 * The host's echo answers "what was I asked", not "which deadline has passed", and the two come
 * apart across a step that never committed: silence is checked before the wall clock, so round N
 * interrupts on `watchdog`, and by the time round N+1 attaches and reads the host's answer the
 * budget is spent as well. Taken at face value that is a `watchdog` timeout, and
 * `shouldStopAttemptLoop` starts another attempt with a fresh budget — the #358 shape
 * `inheritedCause` exists to prevent, arriving through the echo instead.
 *
 * Only this side can make the correction: an exhausted budget stays exhausted whatever timer
 * fired first, and it is a pure function of the handle's start that the host cannot see. The
 * other direction is never taken — a `budget` cause is not downgraded, because a turn the
 * budget stopped is over on this side's own arithmetic.
 */
export function budgetOutranks(result: AttemptResult, input: AttachRoundInput, now: number): AttemptResult {
  if (result.outcome !== 'timed-out' || result.timedOutBy !== 'watchdog') {
    return result
  }
  return turnBudgetExhausted({ startedAt: input.handle.startedAtMs ?? now, now, budgetMs: input.budgetMs })
    ? { ...result, timedOutBy: 'budget' }
    : result
}

/**
 * The cause of a stop *this* round did not send but is being answered — the fallback for a host
 * older than the echo.
 *
 * A round re-entered after a failed step — a retry, or a workflow restart — carries no
 * `interruptedBy`: the interrupt the failed attempt sent is not durable, and neither is the
 * reason it named. What comes back is a `finish { stopped: 'interrupted' }` for a stop this
 * process has no record of asking for, and without a cause `observedResult` would report the
 * turn as one that merely ended, losing `timedOutBy` — which is what `shouldStopAttemptLoop`
 * reads to decide whether the attempt loop may run another turn.
 *
 * A current host answers that outright: it echoes `interruptedBy` on the ending the interrupt
 * caused (#388), and `observedResult` prefers the echo over anything read here. This inference
 * is what is left when the host names none.
 *
 * Only one of the two causes has to survive the gap, because the other is recomputable: the
 * budget is a pure function of the handle's `startedAtMs` and the round's `budgetMs`, and once
 * exhausted it stays exhausted, so {@link turnBudgetExhausted} answers the same question a
 * window later. Anything else is the watchdog by elimination — this Worker sends exactly those
 * two reasons, and `operator` is a protocol member nothing here originates.
 *
 * Only a `finish` is inferred from. A run-phase `error` that carries the host's echo is read as
 * the escalation it is, but one that does not is the ordinary shape of a turn that failed and
 * nothing tells the two apart — so it is left the failure it looks like rather than guessed at.
 */
export function inheritedCause(
  observation: TerminalObservation,
  input: AttachRoundInput,
  now: number,
): TurnTimeoutCause | undefined {
  if (observation.type !== 'finish' || observation.stopped !== 'interrupted') {
    return undefined
  }
  return turnBudgetExhausted({
    startedAt: input.handle.startedAtMs ?? now,
    now,
    budgetMs: input.budgetMs,
  })
    ? 'budget'
    : 'watchdog'
}

/** The watchdog's decision over this round's carried state — `watchdog.ts`'s, from frames. */
export function timeoutCauseOf(context: PumpContext, now: number): TurnTimeoutCause | undefined {
  return turnTimeoutCause({
    startedAt: context.input.handle.startedAtMs ?? context.state.lastActivityAt,
    lastLogActivityAt: context.state.lastActivityAt,
    now,
    budgetMs: context.input.budgetMs,
    watchdogTimeoutMs: context.input.config.watchdogTimeoutMs,
    livenessWindowMs: context.input.config.livenessWindowMs,
  })
}

/**
 * The same verdict {@link judge} makes, for a turn there is no channel to ask.
 *
 * The dial loop waits out its window, and the rounds after it do the same, so a live-but-
 * unreachable host would burn every remaining round — about forty more minutes at the default
 * budget — before `awaitRounds` killed it. The decision function is the shared one; only the
 * stop differs, because a graceful `interrupt` needs a socket and there is none: the kill ladder
 * is the whole of it, and the result still names the timer that fired.
 *
 * For a round entered with the budget already spent this is also the ending of its one short dial:
 * the verdict is `budget` before the dial and still `budget` after it, so a bridge that
 * does not answer costs {@link SPENT_BUDGET_CONNECT_TIMEOUT_MS}, not a full window of dialling.
 */
export async function unreachableTimeout(context: PumpContext): Promise<AttemptResult | undefined> {
  const timedOutBy = timeoutCauseOf(context, context.input.now())
  if (timedOutBy === undefined) {
    return undefined
  }
  console.warn(`unreachable turn host timed out process_id=${context.input.handle.processId} reason=${timedOutBy}`)
  return interruptedResult(timedOutBy, await killTurn(context.input.session, context.input.handle.processId))
}

/**
 * A round that lost its socket and found the process gone.
 *
 * The journal is consulted before that is called a timeout. A host can write its `finish` and
 * exit in the instant the socket was down, and the frame is then only on disk — reported as an
 * unnamed timeout, it *outranks* the transcript the settle replays (`failureOf`), so a completed
 * turn would be recorded as one that wedged. A journal that holds no terminal frame, or that
 * cannot be read at all, leaves the two readings the cli path makes unchanged.
 *
 * The same read answers what the turn said about itself, for the same reason (`readJournalEnding`).
 */
export async function abandoned(
  input: AttachRoundInput,
  interruptedBy: TurnTimeoutCause | undefined,
  carried: TurnVerdict | undefined,
): Promise<AttemptResult> {
  const stateDir = input.handle.bridgeStateDir
  const journal = stateDir === undefined
    ? { verdict: carried }
    : await readJournalEnding(input.session, stateDir, carried)
  if (journal.terminal !== undefined) {
    console.warn(`turn host is gone, its ending read from the journal process_id=${input.handle.processId}`)
    const now = input.now()
    const observed = observedResult(journal.terminal, interruptedBy ?? inheritedCause(journal.terminal, input, now))
    return withVerdict(budgetOutranks(observed, input, now), journal.verdict)
  }
  console.warn(`turn host is gone with no terminal frame process_id=${input.handle.processId}`)
  return { outcome: 'timed-out', killConfirmed: await killTurn(input.session, input.handle.processId) }
}
