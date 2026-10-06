import type { PumpContext } from './sdk-round'
/**
 * The resume settle of a round entered over budget, moved out of `sdk-round.ts` (the file
 * was at the 500-line limit).
 *
 * Everything here is about *when* the early interrupt may go out: arming it after `resume`,
 * whether the settle window is still open, and how long the pump may wait for a frame while the
 * interrupt is only waiting on it, or the "no running turn" grace is. Whether to send it, and what
 * follows, stay with the pump.
 */
import { INTERRUPT_SETTLE_TIMEOUT_MS } from '../cli-turn-kill'

/**
 * How long a round entered over budget lets its resume settle before it sends the interrupt.
 *
 * The bridge takes the greeting's `lastSeq` when the socket connects but picks the replay's
 * boundary only when it handles `resume`, so a running host can end its turn in between: the
 * terminal frame is past the cursor the caller is waiting for, and an interrupt sent on that
 * cursor would be recorded as the cause of an ending the host reached on its own. A replay is one
 * burst the host sends once it has journaled what it holds, so a second of quiet after `resume`
 * is far longer than that burst takes on a healthy bridge, and far shorter than the 10 s sample
 * interval the cadence would otherwise wait. What is left after the settle is the race any
 * interrupt has with a turn ending at the same instant — the pump's cadence judge has it too — so
 * it is no longer one this early interrupt adds.
 *
 * A fixed wait is not a replay boundary, though: the replay sits behind the host's journal chain
 * and can arrive after the settle. The settle therefore only keeps the common case from sending
 * a needless interrupt; correctness rests on reading the host's "no running turn" reply as the
 * stop finding nothing rather than as the turn's ending (`stopFoundNoTurn` in `sdk-round.ts`).
 * An exact boundary would need a protocol-level resume acknowledgement, which this does not
 * attempt.
 */
export const RESUME_SETTLE_MS = 1_000

/**
 * Arm the interrupt a round entered over budget owes its host, right after it sent `resume`.
 * It goes out once the replay is drained up to the greeting's `lastSeq` *and*
 * {@link RESUME_SETTLE_MS} has passed since the `resume`, never before: the bridge picks the
 * replay's boundary when it handles `resume`, so a running host can still hold a terminal frame
 * past the greeting's cursor (the turn driver emits its run-phase `error` before its cleanup
 * returns), and a stop recorded before that frame is consumed would make a turn that failed or
 * finished on its own read as our budget escalation. Only for a host that says it is running —
 * any other state has nothing to stop.
 */
export function armEarlyJudge(
  context: PumpContext,
  spentAtEntry: boolean,
  hostState: string | undefined,
  lastSeq: number | undefined,
): void {
  if (!spentAtEntry || hostState !== 'running') {
    context.earlyJudgeAt = undefined
    context.earlyJudgeNotBefore = undefined
    return
  }
  context.earlyJudgeAt = lastSeq ?? context.state.since
  context.earlyJudgeNotBefore = context.input.now() + RESUME_SETTLE_MS
}

/** Whether the resume's settle window is still open, so no judge may stop the turn yet. */
export function settling(context: PumpContext): boolean {
  return context.earlyJudgeNotBefore !== undefined && context.input.now() < context.earlyJudgeNotBefore
}

/**
 * How long the pump waits for one frame: a sample interval, the window's remains, and — while an
 * early interrupt is only waiting on its settle — the time left until it may go out, so a quiet
 * host is stopped about {@link RESUME_SETTLE_MS} after `resume` rather than a full sample later.
 * Likewise while a "no running turn" reply is pending: the kill that follows its grace is due then,
 * not at the next sample.
 */
export function sliceOf(context: PumpContext, remaining: number): number {
  const slice = Math.min(context.input.config.livenessSampleIntervalMs, remaining)
  const { earlyJudgeAt, earlyJudgeNotBefore, noTurn } = context
  if (noTurn !== undefined) {
    // Woken at the end of the grace, so the kill is not left waiting for a whole sample interval.
    return Math.min(slice, Math.max(noTurn.at + INTERRUPT_SETTLE_TIMEOUT_MS - context.input.now(), 1))
  }
  if (earlyJudgeAt === undefined || earlyJudgeNotBefore === undefined || context.state.since < earlyJudgeAt) {
    return slice
  }
  return Math.min(slice, Math.max(earlyJudgeNotBefore - context.input.now(), 1))
}
