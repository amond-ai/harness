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
import type { HostLossSocket, TurnTimeoutCause } from '../outcome'
import type { AttemptResult, TurnHandle, TurnRoundSpec } from '../turn-driver'
import type { TurnResultScanner } from '../turn-result-scan'
import type { ChannelEnd, TurnChannel } from './sdk-channel'
import type { TerminalObservation } from './sdk-frames'
import type { TurnRoundState } from './sdk-round-state'
import { describeCause as describe } from '@amond-ai/redact'
import { boundedFlush, LIVE_MIRROR_FLUSH_TIMEOUT_MS } from '../mirror'
import { INTERRUPT_SETTLE_TIMEOUT_MS, KILL_SETTLE_TIMEOUT_MS, killTurn } from '../turn-kill'
import { flushOnInterval } from '../turn-mirror-flush'
import { withVerdict } from '../turn-result-scan'
import { foldBackgroundWait, foldStreamPart } from './sdk-background-wait'
import { classifyFrame, isNoRunningTurnReply, isRefusedInterruptReply, streamPartOf } from './sdk-frames'
import { dialBoundOf, enterRound, openChannel } from './sdk-round-dial'
import { confirmedHostLoss } from './sdk-round-gone'
import { judgeAfterNoTurn, stopFoundNoTurn, stopRefused, unreachableEnded } from './sdk-round-noturn'
import { nextFrame, publishFrame } from './sdk-round-observe'
import { armEarlyJudge, resumeAcknowledged, settling, sliceOf } from './sdk-round-settle'
import { applyFrame, interruptedResult, observedResult, roundEnded } from './sdk-round-state'
import { abandoned, budgetOutranks, inheritedCause, timeoutCauseOf } from './sdk-round-verdict'

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
export interface PumpContext {
  input: AttachRoundInput
  process: SandboxProcessHandle | null
  state: TurnRoundState
  /**
   * The highest `seq` the live mirror had already published when the round entered.
   *
   * A frame at or below it is folded into the state like any other but not appended, reported or
   * logged again: a retry resumes from the committed cursor, which can be behind what the failed
   * attempt published, and `append` does not dedupe.
   */
  mirrorFloor: number
  /** The channel the current dial is pumping, so the teardown can say `destroy` on it. */
  channel?: TurnChannel
  deadline: number
  lastFlushAt: number
  /** When the watchdog last read this turn, so a loud one is judged on a cadence too. */
  lastJudgedAt: number
  /**
   * The turn's own `result`, scanned out of the `raw` frames as they go past (#376), seeded from
   * the carried state so an earlier round's reading survives this one.
   */
  scanner: TurnResultScanner
  /**
   * The cursor the current dial's replay has to reach before a round entered over budget sends
   * its interrupt; cleared once it has been judged, so it fires once per dial.
   */
  earlyJudgeAt?: number
  /** When that interrupt may go out at the earliest: `RESUME_SETTLE_MS` after the `resume`. */
  earlyJudgeNotBefore?: number
  /**
   * For a host that acknowledges `resume`, when its `bridge-resumed` is due by: every judge is
   * held until it arrives or this passes (`RESUME_ACK_TIMEOUT_MS`).
   */
  resumeAckBy?: number
  /** Set once the Worker has asked for a stop, so the pump stops asking again. */
  interruptedBy?: TurnTimeoutCause
  /**
   * Set when the host answered an `interrupt` with "no running turn": when the reply came and the
   * cause the forgotten stop named. `judge` sends nothing more, and waits one interrupt grace
   * from `at` for a real ending before the kill ladder.
   *
   * Kept across the round's dials rather than reset per dial: a socket lost after the reply must
   * not turn the unreachable-host verdict into a kill inside that grace, and a redial's replay is
   * where the ending comes. No later reply can mix in, because a reply is only taken while a stop
   * of ours is outstanding (`stopFoundNoTurn`) and nothing sends another once this is set.
   */
  noTurn?: { at: number, cause: TurnTimeoutCause }
}

export async function runAttachRound(input: AttachRoundInput): Promise<TurnRoundState> {
  const { context, spentAtEntry } = await enterRound(input)
  const sleep = input.sleep ?? (async (ms: number) => {
    await new Promise(resolve => setTimeout(resolve, ms))
  })
  const backoff = async (): Promise<void> => await sleep(ROUND_RECONNECT_BACKOFF_MS)
  try {
    for (;;) {
      if (input.signal?.aborted) {
        // Aborted between two dials: the same ending the pump gives it, so a suspend that lands
        // while the bridge is unreachable is not left to wait out the whole window.
        return context.state
      }
      const dialed = await openChannel(input, dialBoundOf(context, spentAtEntry))
      // How this pass lost its channel, for the reading a gone host is abandoned on.
      let socket: HostLossSocket = 'dial-failed'
      if (dialed !== undefined) {
        const { channel } = dialed
        try {
          channel.send({ type: 'resume', lastSeenEventId: context.state.since })
          armEarlyJudge(context, spentAtEntry, dialed)
          const ending = await pump(channel, context)
          if (ending !== 'disconnected') {
            return context.state
          }
          socket = 'socket-closed'
        }
        finally {
          channel.close()
        }
      }
      // Before the probe rather than only at the top of the loop: `confirmedHostLoss` is an
      // unbounded sandbox round trip, so a suspend that landed during the dial would otherwise
      // wait it out and the backoff behind it before the check above sees it.
      if (input.signal?.aborted) {
        return context.state
      }
      // A gone host is confirmed before it is abandoned: one reading that says gone is probed
      // again a `backoff` later, and only a second that agrees ends the turn — a probe that
      // misread a live host as gone would otherwise have the round kill it.
      const reading = await confirmedHostLoss(input.session, input.handle.processId, backoff)
      // And again after it, before either verdict: a suspend that landed during the probe leaves
      // the turn to the next round rather than to a kill decided while it was being taken back.
      if (input.signal?.aborted) {
        return context.state
      }
      if (reading !== undefined) {
        context.state = {
          ...context.state,
          outcome: await abandoned(input, context.interruptedBy, context.state.verdict, { reading, socket, noTurnCause: context.noTurn?.cause }),
        }
        return context.state
      }
      if (await unreachableEnded(context)) {
        return context.state
      }
      if (input.now() >= context.deadline) {
        // The window, spent on dialling rather than on frames. Not an ending: the host is alive
        // by the check above, so the next round attaches to it with the cursor this one carried.
        console.warn(`sdk round could not reach the turn host process_id=${input.handle.processId}`)
        return context.state
      }
      await backoff()
    }
  }
  finally {
    await flushRound(context)
  }
}

/** Why the pump stopped. */
type PumpEnding = 'terminal' | 'window' | 'disconnected'

async function pump(channel: TurnChannel, context: PumpContext): Promise<PumpEnding> {
  context.channel = channel
  for (;;) {
    if (context.input.signal?.aborted) {
      return 'window'
    }
    if (await earlyJudge(channel, context)) {
      return 'terminal'
    }
    const remaining = context.deadline - context.input.now()
    if (remaining <= 0) {
      return 'window'
    }
    const slice = sliceOf(context, remaining)
    const next = await nextFrame(channel, slice, context.input.signal)
    if (next === 'aborted') {
      return 'window'
    }
    if ('end' in next) {
      const ending = await unframedEnding(channel, context, next.end)
      if (ending !== undefined) {
        return ending
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
    if (await cadenceJudge(channel, context)) {
      return 'terminal'
    }
  }
}

/** What a read that came back without a frame means: a lost socket, or a quiet sample. */
async function unframedEnding(
  channel: TurnChannel,
  context: PumpContext,
  end: ChannelEnd,
): Promise<'disconnected' | 'terminal' | undefined> {
  return end === 'closed' ? 'disconnected' : await quietSample(channel, context)
}

/** The judge a loud host gets once a sample interval has passed since the last one. */
async function cadenceJudge(channel: TurnChannel, context: PumpContext): Promise<boolean> {
  return context.input.now() - context.lastJudgedAt >= context.input.config.livenessSampleIntervalMs
    && await judgeIfDue(channel, context)
}

/**
 * A liveness sample with no frame in it, answering whether it ended the turn (`'terminal'`) or
 * not (`undefined`).
 *
 * `status()` is called for its side effect as much as its answer: it is a request into the
 * container, so `sleepAfter` cannot expire under a turn that is quietly working (D4 point 1).
 */
async function quietSample(channel: TurnChannel, context: PumpContext): Promise<'terminal' | undefined> {
  // Before the probe: `status()` is an unbounded round trip and must not hold back a stop that
  // is already due. Nor may it hold back the host's answer to one just sent, so a probe is not
  // started behind it: the next read takes the answer, and the loop's own cadence probes later.
  const asked = context.interruptedBy
  if (await earlyJudge(channel, context)) {
    return 'terminal'
  }
  if (context.interruptedBy !== asked) {
    return undefined
  }
  // Not while a "no running turn" reply is outstanding: the wait is for a terminal frame the
  // socket will deliver, bounded by `judge`'s grace, and a probe that stalls would hold both the
  // frame and that bound behind an unbounded round trip. Nor while the resume settles: a probe
  // started inside that hold and returning past it would judge ahead of frames queued meanwhile.
  if (context.noTurn === undefined && !settling(context)) {
    await context.process?.status().catch(() => undefined)
  }
  return await judgeIfDue(channel, context) ? 'terminal' : undefined
}

/**
 * The cadence's judge, held back while the resume is still settling or its acknowledgement is
 * awaited, and for a round whose suspend is requested.
 *
 * Both guards are checked here, after whatever the caller awaited: a stop sent inside the settle
 * window could be recorded as the cause of an ending the host reached on its own, and a suspend
 * ends observation and leaves the turn running, so a stop sent once it has landed — for instance
 * while a `status()` probe was in flight — would outrun the abort guard at the top of the loop.
 */
async function judgeIfDue(channel: TurnChannel, context: PumpContext): Promise<boolean> {
  return !settling(context) && context.input.signal?.aborted !== true && await judge(channel, context)
}

/**
 * The interrupt a round entered over budget owes its host, once the replay has reached
 * `earlyJudgeAt` and the resume has settled — or, on a host that acknowledges `resume`,
 * once its `bridge-resumed` is in. The guard against a requested suspend is
 * {@link judgeIfDue}'s.
 */
async function earlyJudge(channel: TurnChannel, context: PumpContext): Promise<boolean> {
  const target = context.earlyJudgeAt
  if (target === undefined || context.state.since < target || settling(context)) {
    return false
  }
  context.earlyJudgeAt = undefined
  context.earlyJudgeNotBefore = undefined
  context.resumeAckBy = undefined
  return await judgeIfDue(channel, context)
}

/** Fold one frame in, answering whether it ended the turn. */
async function consume(frame: string, context: PumpContext): Promise<boolean> {
  const effect = classifyFrame(frame)
  const now = context.input.now()
  if (effect.kind === 'unreadable') {
    console.warn(`bridge frame unreadable process_id=${context.input.handle.processId} reason="${effect.reason}"`)
    return false
  }
  if (isNoRunningTurnReply(effect)) {
    return stopFoundNoTurn(context)
  }
  if (isRefusedInterruptReply(effect)) {
    return await stopRefused(context)
  }
  if (effect.kind === 'resumed') {
    return resumeAcknowledged(context)
  }
  const seq = 'seq' in effect ? effect.seq : undefined
  // Already published by the attempt that saw it first: folded again, not re-emitted.
  const published = seq !== undefined && seq <= context.mirrorFloor
  if (!published) {
    publishFrame(frame, effect, context)
  }
  if (effect.kind === 'transcript') {
    // One `raw` frame is one line by construction, so neither read needs reassembly here.
    context.scanner.text(effect.line)
    context.state = foldBackgroundWait(context.state, effect.line)
  }
  const { awaitingBackground, structuredOutputPending } = context.state
  const part = effect.kind === 'liveness' && (awaitingBackground || structuredOutputPending) ? streamPartOf(frame) : undefined
  if (part !== undefined) {
    context.state = foldStreamPart(context.state, part)
  }
  context.state = scanned(applyFrame(context.state, effect, now), context.scanner)
  context.lastFlushAt = await flushOnInterval(
    context.input.mirror,
    context.lastFlushAt,
    now,
    context.input.handle.processId,
  )
  if (effect.kind === 'terminal') {
    context.state = {
      ...context.state,
      outcome: withVerdict(await settle(effect.observation, context), context.state.verdict),
    }
    return true
  }
  return false
}

/** The round's state with whatever the scan has read carried on it, and nothing else changed. */
function scanned(state: TurnRoundState, scanner: TurnResultScanner): TurnRoundState {
  const verdict = scanner.verdict()
  return verdict === undefined || verdict === state.verdict ? state : { ...state, verdict }
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
 * and an exit that does not come inside it falls through to the driver's kill ladder — SIGINT,
 * then the backend's default.
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
  if (context.noTurn !== undefined) {
    return await judgeAfterNoTurn(context, context.noTurn, now)
  }
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
