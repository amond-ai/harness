import type { PumpContext } from './sdk-round'
/**
 * The resume settle of a round entered over budget, moved out of `sdk-round.ts` (the file
 * was at the 500-line limit).
 *
 * Everything here is about *when* the early interrupt may go out: arming it after `resume`,
 * taking the host's `bridge-resumed` acknowledgement as the end of the replay, whether the
 * settle window or the wait for that acknowledgement is still open, and how long the pump may
 * wait for a frame while the interrupt is only waiting on one of them, or the "no running turn"
 * grace is. Whether to send it, and what follows, stay with the pump.
 */
import { INTERRUPT_SETTLE_TIMEOUT_MS } from '../cli-turn-kill'

/**
 * How long a round entered over budget lets its resume settle before it sends the interrupt,
 * on a host that does not acknowledge `resume`.
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
 * and can arrive after the settle. A host whose greeting advertises `resumeAck` says where the
 * replay ends with `bridge-resumed`, and the early interrupt waits for that instead. The
 * settle and the greeting's `lastSeq` are the fallback for hosts that predate it, where they only
 * keep the common case from sending a needless interrupt, and reading the host's "no running
 * turn" reply as the stop finding nothing (`stopFoundNoTurn` in `sdk-round-noturn.ts`) still
 * covers the rest.
 */
export const RESUME_SETTLE_MS = 1_000

/**
 * How long a round entered over budget waits for a `bridge-resumed` from a host that promised
 * one, before it falls back to the greeting's `lastSeq`.
 *
 * The acknowledgement goes out right behind the replayed tail, which is one burst behind the
 * host's journal appends, so five seconds is generous on any bridge that is answering at all. The
 * bound exists only so a lost acknowledgement cannot hold the stop the budget already owes.
 */
export const RESUME_ACK_TIMEOUT_MS = 5_000

/** What the greeting said that the early interrupt acts on: `openChannel`'s answer, less the channel. */
export interface Greeting {
  hostState: string | undefined
  lastSeq: number | undefined
  resumeAck: boolean
}

/**
 * Arm the interrupt a round entered over budget owes its host, right after it sent `resume`.
 * It goes out once the replay is drained up to the greeting's `lastSeq` *and*
 * {@link RESUME_SETTLE_MS} has passed since the `resume`, never before: the bridge picks the
 * replay's boundary when it handles `resume`, so a running host can still hold a terminal frame
 * past the greeting's cursor (the turn driver emits its run-phase `error` before its cleanup
 * returns), and a stop recorded before that frame is consumed would make a turn that failed or
 * finished on its own read as our budget escalation. Only for a host that says it is running —
 * any other state has nothing to stop.
 *
 * A host that acknowledges `resume` is waited on for its `bridge-resumed` instead, with no settle:
 * that frame is the replay's end, where `lastSeq` is only an approximation of it — it also
 * counts the live-only frames no replay sends, so a cursor waiting on it may never get there. The
 * `lastSeq` target is still armed, settle counted as elapsed, for an acknowledgement that does not
 * come inside {@link RESUME_ACK_TIMEOUT_MS}.
 *
 * Nothing is armed on a redial once a stop has gone out — still outstanding, or forgotten on a
 * "no running turn" reply: `judge` owes that stop's grace and then the kill. A fresh settle
 * would hold that judge back, and a redial that lands late in the grace would let the window
 * end on a live state with the timed-out turn neither recorded nor killed.
 */
export function armEarlyJudge(context: PumpContext, spentAtEntry: boolean, greeting: Greeting): void {
  context.resumeAckBy = undefined
  context.earlyJudgeNotBefore = undefined
  if (!spentAtEntry || greeting.hostState !== 'running' || context.noTurn !== undefined || context.interruptedBy !== undefined) {
    context.earlyJudgeAt = undefined
    return
  }
  context.earlyJudgeAt = greeting.lastSeq ?? context.state.since
  if (greeting.resumeAck) {
    context.resumeAckBy = context.input.now() + RESUME_ACK_TIMEOUT_MS
    return
  }
  context.earlyJudgeNotBefore = context.input.now() + RESUME_SETTLE_MS
}

/**
 * Take the host's `bridge-resumed` as the end of the replay, answering that it did not end
 * the turn.
 *
 * Everything the replay held is consumed by now — it went out ahead of this frame on the same
 * socket — so the early interrupt is due at the pump's next pass: its target becomes the cursor
 * as it stands. The frame itself is neither the turn's record nor its ending, and moves nothing
 * else. One that arrives with nothing waiting on it, or after the early interrupt has gone out,
 * is ignored; one that arrives after its wait ran out still ends the wait for the `lastSeq`
 * target, since it is the boundary that target only approximates.
 */
export function resumeAcknowledged(context: PumpContext): false {
  if (context.resumeAckBy !== undefined && context.earlyJudgeAt !== undefined) {
    context.resumeAckBy = undefined
    context.earlyJudgeAt = context.state.since
  }
  return false
}

/**
 * Whether the resume's settle window, or the wait for its acknowledgement, is still open, so no
 * judge may stop the turn yet.
 *
 * On a host that does not acknowledge `resume`, the settle is followed by the replay itself: the
 * cadence and quiet-sample judges are held while the cursor is short of the greeting's `lastSeq`,
 * as the early interrupt is, or a stop sent ahead of a late replay would be recorded as the cause
 * of a terminal frame still in it. Held no longer than {@link RESUME_ACK_TIMEOUT_MS} after the
 * `resume`, the bound an acknowledging host is given: `lastSeq` also counts live-only frames no
 * replay sends, so a cursor waiting on it may never get there.
 */
export function settling(context: PumpContext): boolean {
  // The clock is read only when a window is open: a round's tests script `now()` call by call.
  const { earlyJudgeAt, earlyJudgeNotBefore, resumeAckBy } = context
  return (earlyJudgeNotBefore !== undefined && context.input.now() < earlyJudgeNotBefore)
    || (resumeAckBy !== undefined && context.input.now() < resumeAckBy)
    || (earlyJudgeNotBefore !== undefined && earlyJudgeAt !== undefined && context.state.since < earlyJudgeAt
      && context.input.now() < earlyJudgeNotBefore - RESUME_SETTLE_MS + RESUME_ACK_TIMEOUT_MS)
}

/**
 * How long the pump waits for one frame: a sample interval, the window's remains, and — while an
 * early interrupt is only waiting on its settle — the time left until it may go out, so a quiet
 * host is stopped about {@link RESUME_SETTLE_MS} after `resume` rather than a full sample later.
 * Likewise while a "no running turn" reply is pending: the kill that follows its grace is due then,
 * not at the next sample. And while the acknowledgement of a `resume` is awaited, the fallback to
 * `lastSeq` is due at {@link RESUME_ACK_TIMEOUT_MS}, so a host that lost it is not left a sample.
 */
export function sliceOf(context: PumpContext, remaining: number): number {
  const slice = Math.min(context.input.config.livenessSampleIntervalMs, remaining)
  const { earlyJudgeAt, earlyJudgeNotBefore, noTurn, resumeAckBy } = context
  if (noTurn !== undefined) {
    // Woken at the end of the grace, so the kill is not left waiting for a whole sample interval.
    return Math.min(slice, Math.max(noTurn.at + INTERRUPT_SETTLE_TIMEOUT_MS - context.input.now(), 1))
  }
  if (resumeAckBy !== undefined && context.input.now() < resumeAckBy) {
    return Math.min(slice, Math.max(resumeAckBy - context.input.now(), 1))
  }
  if (earlyJudgeAt === undefined || earlyJudgeNotBefore === undefined || context.state.since < earlyJudgeAt) {
    return slice
  }
  return Math.min(slice, Math.max(earlyJudgeNotBefore - context.input.now(), 1))
}
