import type { TurnTimeoutCause } from '../outcome'
import type { PumpContext } from './sdk-round'
/**
 * What a round does with the host's "no running turn to interrupt" reply, moved out of
 * `sdk-round.ts` (the file was at the 500-line limit).
 *
 * The reply forgets the stop and starts a bounded wait for a real ending; `judgeAfterNoTurn` is
 * where that wait ends in the kill ladder. When to call each stays with the pump.
 */
import { INTERRUPT_SETTLE_TIMEOUT_MS, KILL_SETTLE_TIMEOUT_MS, killTurn } from '../cli-turn-kill'
import { interruptedResult } from './sdk-round-state'
import { unreachableTimeout } from './sdk-round-verdict'

/**
 * The host's reply that our `interrupt` found no running turn, which is not the turn's ending.
 *
 * Two things produce it, and the caller cannot tell them apart: the turn has already ended, or it
 * has not registered its interrupt handler yet (the host says `running` slightly before the turn
 * driver can take a stop). Either way the stop did not land. The reply goes straight out on the
 * socket that sent the stop, while a replay sits behind the
 * host's journal chain — so it can overtake the real terminal frame, which is still on its way
 * (replay or live). Read as a terminal run error it would end the turn as a failure of the stop
 * we sent, and a turn that completed or failed on its own would be recorded under our budget
 * escalation. So the stop is forgotten instead: it never landed, the real ending is read on its
 * own terms, and the next round does not inherit it. `judge` then sends nothing more on this
 * socket, or the cadence would re-interrupt every sample while the budget stays spent. It waits
 * one interrupt grace for a real ending — a terminal frame that comes meanwhile is read as it is
 * — and past that takes the kill ladder under the cause the forgotten stop named, because a turn
 * that never ends after the reply would otherwise be re-stopped, and re-answered, by every later
 * round. The round's deadline is held past that bound so the window cannot cut it short.
 *
 * A host that acknowledges `resume` is sent the early interrupt only once its
 * `bridge-resumed` is in, so on it this reply covers only the race any interrupt has with a turn
 * ending at the same instant — unless no acknowledgement comes within `RESUME_ACK_TIMEOUT_MS`, in
 * which case the early interrupt falls back to the `lastSeq` target and the reply covers what it
 * does on an older host. On a host older than the acknowledgement, whose early interrupt still
 * rests on the settle and `lastSeq`, it also covers a replay later than the settle. The one case left there is
 * the real terminal arriving *before* this reply — a late replay that is an un-echoed run error.
 * That is read as the escalation, as any interrupt racing a turn that fails at the same instant is.
 */
export function stopFoundNoTurn(context: PumpContext): false {
  const cause = context.interruptedBy
  if (cause === undefined) {
    return false
  }
  console.warn(`interrupt found no running turn process_id=${context.input.handle.processId}; awaiting its ending`)
  const at = context.input.now()
  context.noTurn = { at, cause }
  context.deadline = Math.max(context.deadline, at + INTERRUPT_SETTLE_TIMEOUT_MS + KILL_SETTLE_TIMEOUT_MS)
  context.interruptedBy = undefined
  const { interruptedBy: _by, interruptedAt: _at, ...state } = context.state
  context.state = state
  return false
}

/** After the host's "no running turn" reply: one interrupt grace for a real ending, then the kill. */
export async function judgeAfterNoTurn(
  context: PumpContext,
  noTurn: { at: number, cause: TurnTimeoutCause },
  now: number,
): Promise<boolean> {
  if (now < noTurn.at + INTERRUPT_SETTLE_TIMEOUT_MS) {
    return false
  }
  const killed = await killTurn(context.input.session, context.input.handle.processId)
  context.state = { ...context.state, outcome: interruptedResult(noTurn.cause, killed) }
  return true
}

/**
 * The unreachable-host verdict after a failed dial or a lost socket, answering whether it ended
 * the round.
 *
 * While a "no running turn" reply is pending, the ending is still on its way, and the verdict
 * that would kill a host whose budget is spent must not pre-empt it: inside the grace this ends
 * nothing and the round redials, whose `resume` replays from `since`. Past the grace it is
 * {@link judgeAfterNoTurn}'s kill, the same one a connected pump takes.
 */
export async function unreachableEnded(context: PumpContext): Promise<boolean> {
  if (context.noTurn !== undefined) {
    return await judgeAfterNoTurn(context, context.noTurn, context.input.now())
  }
  const unreachable = await unreachableTimeout(context)
  if (unreachable === undefined) {
    return false
  }
  context.state = { ...context.state, outcome: unreachable }
  return true
}
