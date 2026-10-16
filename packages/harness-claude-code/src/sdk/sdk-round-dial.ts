import type { LiveMirror } from '../mirror'
import type { TurnChannel } from './sdk-channel'
import type { AttachRoundInput, PumpContext } from './sdk-round'
/**
 * The entry and the dial of one attach round, moved out of `sdk-round.ts` (the file had
 * grown past the 500-line limit and `runAttachRound` carried its own entry logic).
 *
 * Everything here happens before the round has a socket to pump: building the round's context
 * from the carried state, deciding whether the turn's budget is already spent, and dialling the
 * bridge with the bound that decision picks.
 */
import { describeCause as describe } from '@amond-ai/redact'
import { INTERRUPT_SETTLE_TIMEOUT_MS, KILL_SETTLE_TIMEOUT_MS } from '../cli-turn-kill'
import { createTurnResultScanner } from '../turn-result-scan'
import { ROUND_WINDOW_MS, turnBudgetExhausted } from '../watchdog'
import { createTurnChannel } from './sdk-channel'
import { classifyFrame } from './sdk-frames'
import { nextFrame } from './sdk-round-observe'

/** How long a connect and its `bridge-hello` may take before the round calls the socket dead. */
export const BRIDGE_CONNECT_TIMEOUT_MS = 30_000

/**
 * The same bound for a round entered with the turn's wall-clock budget already spent.
 *
 * That round has one job — stop the turn — and the full {@link BRIDGE_CONNECT_TIMEOUT_MS} twice
 * over (connect, then `bridge-hello`) is a minute the budget no longer has: an unreachable bridge
 * would let the turn overrun by that much before the round reached the verdict it already knew.
 * Short enough that a dead bridge ends the round quickly, long enough for a healthy one to answer.
 */
export const SPENT_BUDGET_CONNECT_TIMEOUT_MS = 5_000

/**
 * What a round starts from: its context, whether its budget was already spent on entry, and the
 * dial bound that follows from it.
 */
export async function enterRound(
  input: AttachRoundInput,
): Promise<{ context: PumpContext, spentAtEntry: boolean, dialBound: DialBound }> {
  // Read after the process lookup, not before: it is a sandbox round trip, and a budget that ran
  // out during it would otherwise be judged on a clock from before it and dialled with the full bound.
  const hostProcess = await input.session.getProcess(input.handle.processId)
  const now = input.now()
  const carried = input.previous ?? { since: 0, lastActivityAt: now }
  const context: PumpContext = {
    input,
    process: hostProcess,
    // From the committed cursor, not the mirror's: they differ only after a failed step,
    // and what that attempt folded — its `verdict`, the background wait — is not durable. The
    // host's in-memory event log still holds the whole turn, so the replay is folded again here.
    // The mirror's cursor, durable at every flush (`append` does not dedupe), is the separate
    // `mirrorFloor` that keeps the replay from repeating a transcript prefix.
    //
    // Silence is judged inside a round's own observation: replayed frames refresh the clock with
    // their arrival time (`applyFrame`), and a re-entry must not read a gap it never watched as
    // silence. The cost is a fresh watchdog window per round, bounded by `watchdogTimeoutMs`.
    state: {
      ...carried,
      lastActivityAt: Math.max(carried.lastActivityAt, now),
    },
    mirrorFloor: mirrorCursor(input.mirror),
    interruptedBy: carried.interruptedBy,
    // A round that inherits an outstanding interrupt gets the remains of that stop's settle
    // budget, not a fresh window: the stop was decided a window ago and what is left to decide is
    // only whether the host answered it. Never in the past, so the round still takes one sample.
    deadline: carried.interruptedBy !== undefined && carried.interruptedAt !== undefined
      ? Math.max(
          now + input.config.livenessSampleIntervalMs,
          carried.interruptedAt + INTERRUPT_SETTLE_TIMEOUT_MS + KILL_SETTLE_TIMEOUT_MS,
        )
      : now + ROUND_WINDOW_MS,
    lastFlushAt: now,
    lastJudgedAt: now,
    scanner: createTurnResultScanner(carried.verdict),
  }
  // A budget already spent when the round starts is decided before the first dial, not after it.
  // Not when the carried state holds an outstanding interrupt: that stop was decided a
  // window ago and the round only has to wait out its settle budget, as the deadline above says.
  const spentAtEntry = carried.interruptedBy === undefined
    && input.handle.startedAtMs !== undefined
    && turnBudgetExhausted({ startedAt: input.handle.startedAtMs, now, budgetMs: input.budgetMs })
  // The stop's own settle deadline, not the round's: that one is floored a sample interval out so
  // the round still samples once, and reading it here would hand an overdue stop the full bound.
  const settleLeftMs = carried.interruptedAt === undefined
    ? context.deadline - now
    : carried.interruptedAt + INTERRUPT_SETTLE_TIMEOUT_MS + KILL_SETTLE_TIMEOUT_MS - now
  return { context, spentAtEntry, dialBound: dialBound(spentAtEntry, carried.interruptedBy !== undefined, settleLeftMs) }
}

/**
 * How long one dial may take: `timeoutMs`, either for the connect and the greeting each, or —
 * when `shared` — for the two together, as one handshake deadline.
 */
export interface DialBound {
  timeoutMs: number
  shared: boolean
}

/**
 * The bound one dial gets: the short one for a round entered over budget, and for a round that
 * inherits an outstanding interrupt, what is left of that stop's settle deadline — never less
 * than the short bound, so a healthy bridge can still answer, nor more than the full one. A full
 * connect and greeting would otherwise postpone a kill that is already due by up to a minute.
 *
 * Both of those rounds owe a stop, so their bound is one deadline for the whole handshake: given
 * per phase, a socket that arrives just inside it and then never greets would hold the stop for
 * a second bound. The full bound stays per phase — nothing is owed yet, and a runtime slow to
 * complete the upgrade should still get the whole greeting wait.
 */
function dialBound(spentAtEntry: boolean, stopOutstanding: boolean, settleLeftMs: number): DialBound {
  if (spentAtEntry) {
    return { timeoutMs: SPENT_BUDGET_CONNECT_TIMEOUT_MS, shared: true }
  }
  return stopOutstanding
    ? { timeoutMs: Math.min(BRIDGE_CONNECT_TIMEOUT_MS, Math.max(settleLeftMs, SPENT_BUDGET_CONNECT_TIMEOUT_MS)), shared: true }
    : { timeoutMs: BRIDGE_CONNECT_TIMEOUT_MS, shared: false }
}

/**
 * Dial and shake hands, answering `undefined` for a dial the round should simply retry.
 *
 * `bound` is {@link dialBound}'s: {@link BRIDGE_CONNECT_TIMEOUT_MS} for the connect and the
 * greeting each, or — for a round entered over budget or inheriting a stop — one shorter deadline
 * the two share, the greeting getting only what the connect left of it. The
 * greeting's `state`, `lastSeq` and whether it acknowledges a `resume` (`resumeAck`) come
 * back with the channel, for the early interrupt that acts on them.
 */
export async function openChannel(
  input: AttachRoundInput,
  bound: DialBound,
): Promise<{ channel: TurnChannel, hostState: string | undefined, lastSeq: number | undefined, resumeAck: boolean } | undefined> {
  let channel: TurnChannel
  const { timeoutMs } = bound
  // Elapsed on `Date.now()` rather than `input.now()`: the round's clock is scripted read by read
  // in tests, and this is a timer's measure, which fake timers drive as they drive the deadline.
  const dialedAt = Date.now()
  const dial = input.connect()
  try {
    // Raced against a suspend as well as the deadline, as the greeting below is: a connect that
    // hangs would otherwise hold a `doSuspendTurn` for the whole bound.
    channel = createTurnChannel(await withTimeout(dial, timeoutMs, input.signal))
  }
  catch (cause) {
    // The dial is not cancellable, so a socket that arrives after the deadline is closed on
    // arrival instead of being abandoned: the bridge keeps only one active socket, and a late
    // greeting would displace the one the *current* round is pumping and starve it.
    void dial.then(socket => socket.close(), () => undefined)
    if (input.signal?.aborted !== true) {
      console.warn(`bridge connect failed process_id=${input.handle.processId} error="${describe(cause)}"`)
    }
    return undefined
  }
  // `bridge-hello` before anything else: some sandbox runtimes complete the upgrade before the
  // connection reaches the bridge process, and a `resume` sent into that gap is dropped.
  //
  // Waited through `nextFrame` rather than `channel.next` so the wait is raced against a suspend:
  // a bridge that completes the upgrade and then never greets would otherwise hold a
  // `doSuspendTurn` for the full connect timeout with nothing to show for it.
  const greetingMs = bound.shared ? timeoutMs - (Date.now() - dialedAt) : timeoutMs
  const hello = greetingMs > 0 ? await nextFrame(channel, greetingMs, input.signal) : { end: 'deadline' as const }
  if (hello === 'aborted') {
    channel.close()
    return undefined
  }
  const greeting = 'frame' in hello ? classifyFrame(hello.frame) : undefined
  if (greeting?.kind !== 'hello') {
    console.warn(`bridge did not greet the connection process_id=${input.handle.processId}`)
    channel.close()
    return undefined
  }
  return { channel, hostState: greeting.state, lastSeq: greeting.lastSeq, resumeAck: greeting.resumeAck === true }
}

/**
 * What the mirror says it has already published, as a `seq`.
 *
 * The sdk path appends with the frame's own `seq` as the cursor, so the stored cursor and
 * `TurnRoundState.since` are the same unit; anything unreadable counts as nothing published.
 */
function mirrorCursor(mirror: LiveMirror | undefined): number {
  const cursor = Number(mirror?.cursor)
  return Number.isFinite(cursor) ? cursor : 0
}

/**
 * A promise with a deadline, and with an abort when a `signal` is given; the loser is abandoned
 * rather than cancelled — there is no cancel.
 */
export async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${String(timeoutMs)}ms`)), timeoutMs)
    onAbort = () => reject(new Error('aborted'))
    if (signal?.aborted === true) {
      onAbort()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  return await Promise.race([promise, deadline]).finally(() => {
    clearTimeout(timer)
    if (onAbort !== undefined) {
      signal?.removeEventListener('abort', onAbort)
    }
  })
}
