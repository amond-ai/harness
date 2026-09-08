/**
 * One attach round: connect, catch up, consume frames for a bounded window, and hand back what
 * the next round needs (D4).
 *
 * A round is a Workflow step, and that is the whole reason it is bounded: a six-hour turn held
 * in one step would spend the per-step CPU meter on the socket, and an eviction would lose
 * everything the step had seen. A round that ends on its window is the ordinary case — the next
 * one re-attaches with `resume { lastSeenEventId }` and the host's journal fills the gap.
 *
 * Socket loss is not a turn failure. Losing the connection loses nothing the journal does not
 * still hold, so a drop reconnects and replays; only a reconnect that finds the process gone
 * *and* no terminal frame in what came back is the abandoned reading.
 *
 * The re-dialling is bounded by the round's own window, not by a number of attempts. A fixed
 * count would let a bridge that refuses connections end the round in seconds, and the attempt
 * loop counts every returned round against `maxAttachRounds` — so a handful of fast failures
 * would exhaust the turn's rounds and kill a healthy host as a `budget` timeout, hours early.
 */
import type { WsLike } from '@amond-ai/harness-transport'
import type { SandboxProcessHandle, SandboxSession } from '@amond-ai/sandbox'
import type { TurnDriverConfig } from '../config'
import type { LiveMirror } from '../mirror'
import type { TurnTimeoutCause } from '../outcome'
import type { AttemptResult, TurnHandle, TurnRoundSpec } from '../turn-driver'
import type { TurnChannel } from './sdk-channel'
import type { TerminalObservation } from './sdk-frames'
import type { TurnRoundState } from './sdk-round-state'
import { describeCause as describe } from '@amond-ai/redact'
import { INTERRUPT_SETTLE_TIMEOUT_MS, KILL_SETTLE_TIMEOUT_MS, killTurn } from '../cli-turn-kill'
import { boundedFlush, LIVE_MIRROR_FLUSH_TIMEOUT_MS } from '../mirror'
import { flushOnInterval } from '../turn-mirror-flush'
import { ROUND_WINDOW_MS, turnBudgetExhausted, turnTimeoutCause } from '../watchdog'
import { turnHostJournalPath } from './sdk-bridge-config'
import { createTurnChannel } from './sdk-channel'
import { classifyFrame } from './sdk-frames'
import { journalTerminal, readJournalTail } from './sdk-journal'
import { nextFrame, reportFrame } from './sdk-round-observe'
import { applyFrame, interruptedResult, observedResult, roundEnded } from './sdk-round-state'

/** How long a connect and its `bridge-hello` may take before the round calls the socket dead. */
export const BRIDGE_CONNECT_TIMEOUT_MS = 30_000

/**
 * How long a round waits between two dials.
 *
 * A round re-dials for as long as its window lasts rather than a fixed number of times, so the
 * gap is what keeps that from being a spin: a bridge that is not answering is re-tried about once
 * a second, not as fast as `connect` can reject.
 */
export const ROUND_RECONNECT_BACKOFF_MS = 1_000

export interface AttachRoundInput {
  session: SandboxSession
  handle: TurnHandle
  /** Dial the bridge — `sdk-socket.ts` in production, a scripted socket in a test. */
  connect: () => Promise<WsLike>
  config: TurnDriverConfig
  mirror: LiveMirror | undefined
  /** The turn's clamped wall-clock budget, measured from `handle.startedAtMs`. */
  budgetMs: number
  previous: TurnRoundState | undefined
  /** Every readable frame this round folds in, as {@link TurnRoundSpec.onFrame} describes it. */
  onFrame?: TurnRoundSpec['onFrame']
  /** Ends the round as its own window would, on someone else's timer ({@link TurnRoundSpec.signal}). */
  signal?: AbortSignal
  now: () => number
  /**
   * The pause between two failed dials; a real timer unless a test hands one in.
   *
   * Injected for the same reason `now` is: the reconnect loop is bounded by the round's window
   * rather than by a count, so proving it neither gives up early nor spins means driving the
   * clock rather than waiting on one.
   */
  sleep?: (ms: number) => Promise<void>
}

/** Everything the frame pump reads and writes, past the five-argument limit. */
interface PumpContext {
  input: AttachRoundInput
  process: SandboxProcessHandle | null
  state: TurnRoundState
  /** The channel the current dial is pumping, so the teardown can say `destroy` on it. */
  channel?: TurnChannel
  deadline: number
  lastFlushAt: number
  /** When the watchdog last read this turn, so a loud one is judged on a cadence too. */
  lastJudgedAt: number
  /** Set once the Worker has asked for a stop, so the pump stops asking again. */
  interruptedBy?: TurnTimeoutCause
}

export async function runAttachRound(input: AttachRoundInput): Promise<TurnRoundState> {
  const now = input.now()
  const carried = input.previous ?? { since: 0, lastActivityAt: now }
  const context: PumpContext = {
    input,
    process: await input.session.getProcess(input.handle.processId),
    // Never behind what the mirror has already published: the mirror's cursor is durable at every
    // flush inside the round, `state.since` only when the round's step commits. A round re-entered
    // after an eviction that resumed from the older of the two would be sent frames the re-seeded
    // mirror already holds, and `append` does not dedupe — the transcript would repeat a prefix.
    //
    // Silence is judged inside a round's own observation. Replayed frames refresh the clock with
    // their arrival time (`applyFrame`), so a re-entry that replays nothing — the cursor above is
    // floored at what the mirror already published — must not read the gap it never watched as
    // silence and interrupt a healthy host seconds in. The cost is that a host that went quiet at
    // the end of one round gets a fresh watchdog window in the next, bounded by `watchdogTimeoutMs`.
    state: {
      ...carried,
      since: Math.max(carried.since, mirrorCursor(input.mirror)),
      lastActivityAt: Math.max(carried.lastActivityAt, now),
    },
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
  }
  const sleep = input.sleep ?? (async (ms: number) => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
  try {
    for (;;) {
      if (input.signal?.aborted) {
        // Aborted between two dials: the same ending the pump gives it, so a suspend that lands
        // while the bridge is unreachable is not left to wait out the whole window.
        return context.state
      }
      const channel = await openChannel(input)
      if (channel !== undefined) {
        try {
          channel.send({ type: 'resume', lastSeenEventId: context.state.since })
          const ending = await pump(channel, context)
          if (ending !== 'disconnected') {
            return context.state
          }
        }
        finally {
          channel.close()
        }
      }
      // Before the probe rather than only at the top of the loop: `processGone` is an unbounded
      // sandbox round trip, so a suspend that landed during the dial would otherwise wait it out
      // and the backoff behind it before the check above sees it.
      if (input.signal?.aborted) {
        return context.state
      }
      if (await processGone(input.session, input.handle.processId)) {
        // Gone, and nothing terminal came back with the replay: the same two readings
        // `abandonedWaitResult` makes on the cli path, decided the same way.
        context.state = { ...context.state, outcome: await abandoned(input, context.interruptedBy) }
        return context.state
      }
      const unreachable = await unreachableTimeout(context)
      if (unreachable !== undefined) {
        context.state = { ...context.state, outcome: unreachable }
        return context.state
      }
      if (input.now() >= context.deadline) {
        // The window, spent on dialling rather than on frames. Not an ending: the host is alive
        // by the check above, so the next round attaches to it with the cursor this one carried.
        console.warn(`sdk round could not reach the turn host process_id=${input.handle.processId}`)
        return context.state
      }
      await sleep(ROUND_RECONNECT_BACKOFF_MS)
    }
  }
  finally {
    await flushRound(context)
  }
}

/** Dial and shake hands, answering `undefined` for a dial the round should simply retry. */
async function openChannel(input: AttachRoundInput): Promise<TurnChannel | undefined> {
  let channel: TurnChannel
  const dial = input.connect()
  try {
    channel = createTurnChannel(await withTimeout(dial, BRIDGE_CONNECT_TIMEOUT_MS))
  }
  catch (cause) {
    // The dial is not cancellable, so a socket that arrives after the deadline is closed on
    // arrival instead of being abandoned: the bridge keeps only one active socket, and a late
    // greeting would displace the one the *current* round is pumping and starve it.
    void dial.then(socket => socket.close(), () => undefined)
    console.warn(`bridge connect failed process_id=${input.handle.processId} error="${describe(cause)}"`)
    return undefined
  }
  // `bridge-hello` before anything else: some sandbox runtimes complete the upgrade before the
  // connection reaches the bridge process, and a `resume` sent into that gap is dropped.
  //
  // Waited through `nextFrame` rather than `channel.next` so the wait is raced against a suspend:
  // a bridge that completes the upgrade and then never greets would otherwise hold a
  // `doSuspendTurn` for the full connect timeout with nothing to show for it.
  const hello = await nextFrame(channel, BRIDGE_CONNECT_TIMEOUT_MS, input.signal)
  if (hello === 'aborted') {
    channel.close()
    return undefined
  }
  if (!('frame' in hello) || classifyFrame(hello.frame).kind !== 'hello') {
    console.warn(`bridge did not greet the connection process_id=${input.handle.processId}`)
    channel.close()
    return undefined
  }
  return channel
}

/** Why the pump stopped. */
type PumpEnding = 'terminal' | 'window' | 'disconnected'

async function pump(channel: TurnChannel, context: PumpContext): Promise<PumpEnding> {
  context.channel = channel
  for (;;) {
    if (context.input.signal?.aborted) {
      return 'window'
    }
    const remaining = context.deadline - context.input.now()
    if (remaining <= 0) {
      return 'window'
    }
    const slice = Math.min(context.input.config.livenessSampleIntervalMs, remaining)
    const next = await nextFrame(channel, slice, context.input.signal)
    if (next === 'aborted') {
      return 'window'
    }
    if ('end' in next) {
      if (next.end === 'closed') {
        return 'disconnected'
      }
      // A liveness sample with no frame in it. `status()` is called for its side effect as much
      // as its answer: it is a request into the container, so `sleepAfter` cannot expire under a
      // turn that is quietly working (D4 point 1).
      await context.process?.status().catch(() => undefined)
      if (await judge(channel, context)) {
        return 'terminal'
      }
      continue
    }
    if (await consume(next.frame, context)) {
      return 'terminal'
    }
    // Judged on a cadence rather than only on the silent arm above. A host emitting faster than
    // one sample interval never reaches that arm, so its budget would never be read — and the
    // wedge #358 recorded was loud, which is exactly the turn that has to be interrupted rather
    // than left to a round exhaustion's bare kill.
    if (context.input.now() - context.lastJudgedAt >= context.input.config.livenessSampleIntervalMs
      && await judge(channel, context)) {
      return 'terminal'
    }
  }
}

/** Fold one frame in, answering whether it ended the turn. */
async function consume(frame: string, context: PumpContext): Promise<boolean> {
  const effect = classifyFrame(frame)
  const now = context.input.now()
  if (effect.kind === 'unreadable') {
    console.warn(`bridge frame unreadable process_id=${context.input.handle.processId} reason="${effect.reason}"`)
    return false
  }
  reportFrame(frame, 'seq' in effect ? effect.seq : undefined, context.input.onFrame)
  if (effect.kind === 'log') {
    // The host's captured console output — the `cli` driver's stderr side channel, live.
    console.warn(`turn host ${effect.stream}: ${effect.line}`)
  }
  if (effect.kind === 'transcript') {
    context.input.mirror?.append(new TextEncoder().encode(effect.line), String(effect.seq ?? context.state.since))
  }
  context.state = applyFrame(context.state, effect, now)
  context.lastFlushAt = await flushOnInterval(
    context.input.mirror,
    context.lastFlushAt,
    now,
    context.input.handle.processId,
  )
  if (effect.kind === 'terminal') {
    context.state = { ...context.state, outcome: await settle(effect.observation, context) }
    return true
  }
  return false
}

/**
 * What a terminal frame means for the attempt, and the teardown that follows it.
 *
 * What a terminal frame means is `observedResult`'s answer — shared with the journal read below,
 * so a frame that arrived and the same frame found on disk settle the turn identically.
 */
async function settle(observation: TerminalObservation, context: PumpContext): Promise<AttemptResult> {
  const now = context.input.now()
  const result = budgetOutranks(
    observedResult(observation, context.interruptedBy ?? inheritedCause(observation, context.input, now)),
    context.input,
    now,
  )
  if (observation.type === 'error') {
    console.warn(`turn host error phase=${observation.phase} process_id=${context.input.handle.processId} `
      + `error="${describe(observation.error)}"`)
  }
  const exitCode = await teardown(context)
  // Spread onto the result only where the union has a place for it. A deferred attempt's member
  // deliberately has none: the turn stopped to ask a question, and a host exit code taken after
  // the fact describes the teardown rather than the turn — the loop reads the request, not a code.
  return result.outcome === 'deferred' ? result : { ...result, exitCode }
}

/**
 * End the host process and read its exit code.
 *
 * `destroy` rather than a signal: the host exits 1000 on it, and a host left listening would
 * hold the next attempt's port (`turnHostPort` offsets by attempt so it cannot, but a host per
 * turn that never exits is a container filling with processes either way). The wait is bounded,
 * and an exit that does not come inside it falls through to the same kill ladder the `cli`
 * driver uses — SIGINT, then the backend's default.
 */
async function teardown(context: PumpContext): Promise<number | undefined> {
  const { session, handle } = context.input
  try {
    context.channel?.send({ type: 'destroy' })
    const process = await session.getProcess(handle.processId)
    if (!process) {
      return undefined
    }
    try {
      return (await process.waitForExit({ timeout: KILL_SETTLE_TIMEOUT_MS })).code
    }
    catch {
      await killTurn(session, handle.processId)
      return undefined
    }
  }
  catch (cause) {
    console.warn(`turn host teardown failed process_id=${handle.processId} error="${describe(cause)}"`)
    return undefined
  }
}

/**
 * The watchdog, on frame arrivals instead of log bytes — the decision function itself is
 * `watchdog.ts`'s, unchanged (D4).
 *
 * The first verdict sends `interrupt`, which is a stop that keeps the turn a turn: the SDK
 * still produces a `result` and the host still sends `finish`, so the transcript ends in the
 * agent's own last word. Only a host that does not answer inside its grace plus this side's
 * settle budget is killed.
 */
async function judge(channel: TurnChannel, context: PumpContext): Promise<boolean> {
  const now = context.input.now()
  context.lastJudgedAt = now
  // Once asked, the host is judged on its grace alone: a frame it emits meanwhile refreshes the
  // silence clock, and re-reading the thresholds would let a stop that was already decided
  // lapse — the turn then outlives its grace and ends as a round exhaustion, cause lost.
  const timedOutBy = context.interruptedBy ?? timeoutCauseOf(context, now)
  if (timedOutBy === undefined) {
    return false
  }
  if (context.interruptedBy === undefined) {
    context.interruptedBy = timedOutBy
    console.warn(`interrupting turn process_id=${context.input.handle.processId} reason=${timedOutBy}`)
    channel.send({ type: 'interrupt', reason: timedOutBy })
    // Stored as well as held: the grace can outlast the window, and the next round has to settle
    // the host's answer as the timeout it is rather than as a fresh turn that failed.
    context.state = { ...context.state, interruptedBy: timedOutBy, interruptedAt: now }
    // The host's own grace, plus this side's kill-settle budget: past that it has neither
    // produced a `result` nor escalated, and the kill ladder is what is left.
    context.deadline = now + INTERRUPT_SETTLE_TIMEOUT_MS + KILL_SETTLE_TIMEOUT_MS
    return false
  }
  // The host was asked and is still inside its grace: both arms of `pump` re-enter here every
  // sample interval, which is shorter than the grace, so escalating on the first re-entry would
  // kill a host ten seconds into the fifteen it was promised — and lose the graceful `result`
  // the interrupt exists to collect.
  if (now < (context.state.interruptedAt ?? now) + INTERRUPT_SETTLE_TIMEOUT_MS) {
    return false
  }
  context.state = {
    ...context.state,
    outcome: interruptedResult(context.interruptedBy, await killTurn(context.input.session, context.input.handle.processId)),
  }
  return true
}

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
function budgetOutranks(result: AttemptResult, input: AttachRoundInput, now: number): AttemptResult {
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
function inheritedCause(
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
function timeoutCauseOf(context: PumpContext, now: number): TurnTimeoutCause | undefined {
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
 */
async function unreachableTimeout(context: PumpContext): Promise<AttemptResult | undefined> {
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
 */
async function abandoned(input: AttachRoundInput, interruptedBy: TurnTimeoutCause | undefined): Promise<AttemptResult> {
  const terminal = await journaledTerminal(input)
  if (terminal !== undefined) {
    console.warn(`turn host is gone, its ending read from the journal process_id=${input.handle.processId}`)
    const now = input.now()
    return budgetOutranks(observedResult(terminal, interruptedBy ?? inheritedCause(terminal, input, now)), input, now)
  }
  console.warn(`turn host is gone with no terminal frame process_id=${input.handle.processId}`)
  return { outcome: 'timed-out', killConfirmed: await killTurn(input.session, input.handle.processId) }
}

/** The journal's last terminal frame, or nothing at all — a read that fails is not an ending. */
async function journaledTerminal(input: AttachRoundInput): Promise<TerminalObservation | undefined> {
  const stateDir = input.handle.bridgeStateDir
  if (stateDir === undefined) {
    return undefined
  }
  try {
    const { text, cut } = await readJournalTail(input.session, turnHostJournalPath(stateDir))
    return journalTerminal(text, cut)
  }
  catch (cause) {
    console.warn(`turn host journal read failed process_id=${input.handle.processId} error="${describe(cause)}"`)
    return undefined
  }
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

async function processGone(session: SandboxSession, processId: string): Promise<boolean> {
  try {
    const process = await session.getProcess(processId)
    return !process || (await process.status()).state !== 'running'
  }
  catch {
    // Unknown is not gone: a control-plane blip must not end a turn that is still running.
    return false
  }
}

/**
 * The round's closing put.
 *
 * Final only when the turn is over: a non-final flush publishes the record's exact prefix with
 * the cursor of the text in it, which is what makes the next round's mirror resume rather than
 * repeat. A final one on a turn still running would stamp a partial record and lock the fuller
 * one out (`transcript-mirror.ts`).
 */
async function flushRound(context: PumpContext): Promise<void> {
  const { mirror, handle } = context.input
  if (mirror === undefined) {
    return
  }
  const outcome = context.state.outcome
  await boundedFlush(
    mirror,
    { final: outcome !== undefined, ended: roundEnded(outcome) },
    LIVE_MIRROR_FLUSH_TIMEOUT_MS,
    handle.processId,
  )
}

/** A promise with a deadline; the loser is abandoned rather than cancelled — there is no cancel. */
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${String(timeoutMs)}ms`)), timeoutMs)
  })
  return await Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}
