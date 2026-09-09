/**
 * Watching a `cli` turn: the race between the process's own exit and the watchdog's liveness
 * sampling, and the reading each way out of that race produces.
 *
 * Split from the driver so the loop and the escalation ladder it ends in read separately;
 * everything here moved out of `run-workflow.ts` unchanged.
 */
import type { ProcessExit, SandboxProcessHandle, SandboxSession } from '@amond-ai/sandbox'
import type { TurnDriverConfig } from './config'
import type { LogSample } from './log-sample'
import type { LiveMirror } from './mirror'
import type { AttemptResult } from './turn-driver'
import type { TurnResultScanner } from './turn-result-scan'
import { describeCause as describe, sanitizeErrorSummary } from '@amond-ai/redact'
import { SandboxNoExitRecordError } from '@amond-ai/sandbox'
import { killTurn } from './cli-turn-kill'
import { LOG_READ_TIMEOUT_MS, readLogSample } from './log-sample'
import { boundedFlush, LIVE_MIRROR_FLUSH_TIMEOUT_MS } from './mirror'
import { flushOnInterval } from './turn-mirror-flush'
import { createTurnResultScanner, withVerdict } from './turn-result-scan'
import { clampedTurnBudget, nextSampleDelay, turnTimeoutCause } from './watchdog'

/** Distinguishes a watchdog sample tick from the process's own exit in the race below. */
const TICK = Symbol('watchdog-tick')

/**
 * Wait for the turn to exit, racing the wait against the watchdog's liveness sampling.
 *
 * The cursor reads that measure liveness now also *feed* a mirror, and that is a deliberate
 * change from "only byte counts and cursors — never log content" (#358). Nothing here parses the
 * content — that stays the Agent's, AC-003 — but the bytes are handed to {@link LiveMirror},
 * which reassembles and masks lines and re-puts a snapshot to R2 on a slow tick. It exists
 * because the settle-time replay reads a log the container caps: the 209-minute run replayed as
 * ~30 minutes, while these very reads saw every byte as it went past.
 *
 * A wedged turn is killed rather than abandoned, and its process resource remains replayable for
 * diagnostics afterwards (AC-027).
 *
 * The mirror is drained and closed in a `finally` so *every* exit — a clean exit, a supervisor
 * timeout, either watchdog verdict, an abandoned wait — records the tail written since the last
 * tick. Nothing in that path can reject: the mirror swallows its own put failures, and this step
 * is `NO_RETRIES`, so a mirror that failed a turn would cost the run itself.
 *
 * That closing drain is also where the turn's own `result` message is usually seen (#376). The
 * scan runs on every read this function makes, and the reading it produces is attached to the
 * result *after* the drain — which is why the drain no longer depends on a mirror being
 * configured: the loop's judgment must not turn on whether R2 is bound.
 */
export async function awaitTurn(
  sandbox: SandboxSession,
  processId: string,
  config: TurnDriverConfig,
  live: { mirror: LiveMirror | undefined, startedAtMs?: number },
): Promise<AttemptResult> {
  const { mirror } = live
  const process = await sandbox.getProcess(processId)
  if (!process) {
    throw new Error(`sandbox process ${processId} is no longer tracked`)
  }
  const scanner = createTurnResultScanner()
  // What a previous entry of this step already published, and the one part of the turn's output
  // this entry will not be handed again: the first read below starts at the mirror's cursor, so
  // the result of a turn that ended before a restart is only in there (#376).
  if (mirror?.resumedFrom !== undefined) {
    scanner.text(mirror.resumedFrom)
  }
  // Registered before the first log read, as it was before the mirror split this function: a turn
  // that dies inside that read must not exit with nothing watching for it.
  const exit = process.waitForExit()
  // Mutable and shared with the loop so the drain below resumes from wherever the last tick
  // left the cursor, whichever way the wait ended. It *starts* at the mirror's cursor, which is
  // the seed's when this step was re-entered after a restart: the cursor stored with a snapshot
  // is the cursor of the text in it, so the first read continues rather than repeats.
  const cursor = {
    sample: await readLogSample(process, { bytes: 0, cursor: mirror?.cursor }, mirror, LOG_READ_TIMEOUT_MS, scanner.push),
  }
  const result = await watchAndDrain({
    sandbox,
    process,
    processId,
    config,
    mirror,
    cursor,
    exit,
    startedAtMs: live.startedAtMs,
    scanner,
  })
  return withVerdict(result, scanner.verdict())
}

/** The watch, with the closing drain and flush every one of its exits has to pass through. */
async function watchAndDrain(input: WatchTurnInput): Promise<AttemptResult> {
  const { process, processId, mirror, cursor, scanner } = input
  // Held outside the `try` so the `finally` can read what the wait decided: the closing put's
  // `complete` stamp claims the *turn* is over, and only the result says whether it is.
  let result: AttemptResult | undefined
  try {
    result = await watchTurn(input)
    return result
  }
  finally {
    cursor.sample = await readLogSample(process, cursor.sample, mirror, LOG_READ_TIMEOUT_MS, scanner.push)
    if (mirror !== undefined) {
      await boundedFlush(mirror, { final: true, ended: turnEnded(result) }, LIVE_MIRROR_FLUSH_TIMEOUT_MS, processId)
    }
  }
}

/**
 * Whether the turn's process is actually over — the fact the stored record's `complete` stamp
 * claims, and the one `hasCompleteLiveRecord` makes the settle replay stand down for.
 *
 * Not the same question as "was this the last flush". A step can make its final flush over a turn
 * that is still running: an abandoned wait whose kill went unconfirmed leaves the process
 * possibly alive, and a `watchTurn` that threw left with no reading at all. Stamping either
 * `complete` would lock a partial live record in over a replay that could still see more.
 *
 * An exit code is only ever set by {@link exitResult}, which is reached by observing the process
 * exit, so it is proof on its own; `succeeded` says the same thing for a reading that carried no
 * code. A timeout is over only when the kill was confirmed — which is exactly what
 * `killConfirmed` was introduced to decide for the attempt loop.
 */
function turnEnded(result: AttemptResult | undefined): boolean {
  if (result === undefined) {
    return false
  }
  if (result.exitCode !== undefined || result.outcome === 'succeeded') {
    return true
  }
  return result.outcome === 'timed-out' && result.killConfirmed
}

/** What the process's own exit says the attempt was. A supervisor timeout already reaped it. */
function exitResult(exit: ProcessExit): AttemptResult {
  if (exit.timedOut) {
    return { outcome: 'timed-out', exitCode: exit.code, killConfirmed: true }
  }
  return { outcome: exit.code === 0 ? 'succeeded' : 'failed', exitCode: exit.code }
}

/**
 * When the turn actually started, as the process itself reports it.
 *
 * Falls back to now — the reading a fresh entry would have taken anyway — when the status read
 * fails or answers something `Date.parse` cannot read. A budget measured from too late is a
 * longer turn; refusing to wait at all over an unreadable timestamp would be a lost run.
 */
async function turnStartedAt(process: SandboxProcessHandle): Promise<number> {
  try {
    const { startedAt } = await process.status()
    const parsed = Date.parse(startedAt)
    if (Number.isFinite(parsed)) {
      return parsed
    }
    console.warn(`turn start time unreadable process_id=${process.id} started_at="${startedAt}"`)
  }
  catch (cause) {
    console.warn(`turn start time read failed process_id=${process.id} error="${describe(cause)}"`)
  }
  return Date.now()
}

/** Everything the watchdog loop reads, past the five-argument limit as separate parameters. */
interface WatchTurnInput {
  sandbox: SandboxSession
  process: SandboxProcessHandle
  processId: string
  config: TurnDriverConfig
  mirror: LiveMirror | undefined
  cursor: { sample: LogSample }
  exit: Promise<ProcessExit>
  /** The turn's own `result` message, scanned out of the same reads liveness is measured on. */
  scanner: TurnResultScanner
  /** When `start-turn` pinned this turn's start, absent only for a pre-deploy cached result. */
  startedAtMs?: number
}

/** The race itself, split out of {@link awaitTurn} so the mirror's drain can wrap every exit. */
async function watchTurn(input: WatchTurnInput): Promise<AttemptResult> {
  const { sandbox, process, processId, config, mirror, cursor, exit } = input
  // The turn's own start, not this function's, because `NO_RETRIES` only forbids
  // retry-on-failure: a workflow *restart* re-enters this body against the same live turn (see
  // `startTurn`), and a fresh `Date.now()` would hand that turn a whole second budget.
  const startedAt = input.startedAtMs ?? await turnStartedAt(process)
  // The two clocks differ on purpose. The *budget* measures the turn's whole life, so it runs
  // from the turn's start; the *silence* timer measures how long this step has been watching
  // without seeing output, so it runs from step entry — seeded with the turn's start instead, a
  // re-entry hours into a healthy turn would read every one of those hours as silence and kill it
  // on the first quiet tick.
  let lastLogActivityAt = Date.now()
  let lastFlushAt = lastLogActivityAt
  const budgetMs = clampedTurnBudget(config.turnWallClockBudgetMs)

  for (;;) {
    // Clamped to the wall-clock deadline: the budget is judged only *after* a tick resolves, so
    // a tick that slept past the deadline would let the platform's 6-hour `await-exit` step
    // timeout abort the step before `killTurn`/`timedOutBy` ever ran — which a sampling interval
    // longer than the remaining budget (a 7-hour one, say) is free to configure.
    const { tick, cancel } = sampleTick(nextSampleDelay({
      intervalMs: config.livenessSampleIntervalMs,
      startedAt,
      budgetMs,
      now: Date.now(),
    }))
    let settled: Awaited<typeof exit> | typeof TICK
    try {
      // `exit` is an RPC and can reject; the timer must not outlive the race either way.
      // Cancelled here rather than in a `finally` because the rejection path below awaits a
      // kill, and a `finally` would not run until that finished — leaving the very dangling
      // timer PR-72 removed alive for the length of it.
      settled = await Promise.race([exit, tick]).finally(cancel)
    }
    catch (cause) {
      return await abandonedWaitResult(sandbox, processId, cause)
    }
    if (settled !== TICK) {
      return exitResult(settled)
    }
    // Bounded (`LOG_READ_TIMEOUT_MS`), because the deadline decision below is only reached once
    // this returns: a log backend that stalled here would hold the turn past its wall-clock budget
    // until the platform's 6-hour step timeout aborted the step, with no kill and no `timedOutBy`.
    cursor.sample = await readLogSample(process, cursor.sample, mirror, LOG_READ_TIMEOUT_MS, input.scanner.push)
    const now = Date.now()
    if (cursor.sample.bytes > 0) {
      lastLogActivityAt = now
    }
    lastFlushAt = await flushOnInterval(mirror, lastFlushAt, now, processId)
    // Re-read the clock rather than reusing `now`: the flush above is an R2 put of the whole
    // snapshot, so `now` can be seconds stale by the time the two timers are judged against it,
    // and the wall-clock budget this loop just gained must not be measured on a stale reading.
    const timedOutBy = turnTimeoutCause({
      startedAt,
      lastLogActivityAt,
      now: Date.now(),
      budgetMs,
      watchdogTimeoutMs: config.watchdogTimeoutMs,
      livenessWindowMs: config.livenessWindowMs,
    })
    if (timedOutBy !== undefined) {
      const killConfirmed = await killTurn(sandbox, processId)
      return { outcome: 'timed-out', killConfirmed, timedOutBy }
    }
  }
}

/**
 * Turn a wait that rejected into a terminal attempt result instead of letting it escape.
 *
 * {@link awaitTurn} is the body of a `NO_RETRIES` step, so a rejection reaching the caller
 * aborts the run outright: no `reportComplete`, no terminal state on the issue, and no kill
 * for a process that may still be burning a sandbox. Two readings, as in
 * `materializationExit`. `SandboxNoExitRecordError` proves the turn is already gone
 * without having recorded `$?` — an ordinary failed attempt the loop may safely retry.
 * Anything else stopped the wait for a reason it did not name, including the Cloudflare
 * backend's own `ProcessWaitTimeoutError`; liveness is then unknown, so the process is killed
 * and the attempt reported as a timeout whose `killConfirmed` decides whether another attempt
 * may start. An unbounded wait cannot raise `SandboxWaitTimeoutError`, so it needs no branch
 * of its own — it lands in the unknown one, which is exactly where an impossible reading
 * belongs.
 */
async function abandonedWaitResult(
  sandbox: SandboxSession,
  processId: string,
  cause: unknown,
): Promise<AttemptResult> {
  if (cause instanceof SandboxNoExitRecordError) {
    console.warn(`turn ended without an exit record process_id=${processId}`)
    return { outcome: 'failed' }
  }
  const detail = sanitizeErrorSummary(describe(cause))
  console.warn(`turn wait ended without an exit process_id=${processId} error="${detail ?? ''}"`)
  return { outcome: 'timed-out', killConfirmed: await killTurn(sandbox, processId) }
}

/**
 * The `tick` promise never settles on its own once the caller stops waiting on it — only
 * `Promise.race` in {@link awaitTurn} decides which side wins — so the timer it starts must
 * be cancellable. Left uncancelled, a turn that exits between sample ticks would leave a
 * dangling `setTimeout` alive for up to `intervalMs` on every attempt (PR-72 review).
 */
function sampleTick(intervalMs: number): { tick: Promise<typeof TICK>, cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = new Promise<typeof TICK>((resolve) => {
    timer = setTimeout(resolve, intervalMs, TICK)
  })
  return { tick, cancel: () => clearTimeout(timer) }
}
