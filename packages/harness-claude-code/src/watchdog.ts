/**
 * The watchdog's extend-or-kill decision.
 *
 * The await-exit step races the process exit against a watchdog timer. When the timer
 * fires, the process has not exited — but "no exit" alone does not mean "wedged": a
 * `claude` turn can be quiet for a long stretch while it is genuinely working, and the
 * sandbox's process status cannot tell a wedged start from a live-but-silent one. So the
 * decision is made on *liveness*: the timestamp of the last observed process-log progress.
 *
 * Activity inside the liveness window means the turn is alive, and the wait is extended
 * (AC-026 requires liveness, not exit-absence alone). Otherwise the run is only killed
 * once the silence has also outlasted the configured watchdog timeout — until then the
 * wait is extended, because wall clock is free and only CPU is billed.
 *
 * Pure and import-free so `bun test` can reach it: the workflow that calls it pulls in
 * `cloudflare:workers`, which only resolves inside workerd.
 */

import type { TurnTimeoutCause } from './outcome'

/** Extend the wait for the running turn, or stop waiting and treat the attempt as timed out. */
export type WatchdogDecision = 'extend' | 'timeout'

export interface WatchdogInput {
  /** Epoch millis of the last observed process-log progress. */
  lastLogActivityAt: number
  /** Epoch millis at which the watchdog timer fired. */
  now: number
  /** Silence, in millis, after which a turn with no liveness signal is declared wedged. */
  watchdogTimeoutMs: number
  /** Recency, in millis, within which log progress still counts as a liveness signal. */
  livenessWindowMs: number
}

export function watchdogDecision(input: WatchdogInput): WatchdogDecision {
  const silentForMs = input.now - input.lastLogActivityAt
  // A non-positive delta means the last activity is at or ahead of `now` (clock skew
  // between the sandbox's log timestamps and the workflow's clock) — treat it as alive.
  if (silentForMs <= input.livenessWindowMs) {
    return 'extend'
  }
  return silentForMs >= input.watchdogTimeoutMs ? 'timeout' : 'extend'
}

/** The turn's own wall clock, as the budget decision reads it. */
export interface TurnBudgetInput {
  /** Epoch millis at which this turn's wait began. */
  startedAt: number
  /** Epoch millis at which the watchdog timer fired. */
  now: number
  /** Wall clock, in millis, after which the turn is cut off however loud it still is. */
  budgetMs: number
}

/**
 * Whether the turn has spent its whole wall-clock budget.
 *
 * The second half of the extend-or-kill decision, and deliberately not folded into
 * {@link watchdogDecision}: that one judges *liveness*, and a turn thrashing on a full disk is
 * alive by every measure it has — #358's run printed continuously for 209 minutes while making
 * no progress, so the silence timer never fired and only the platform's 6-hour step timeout was
 * left to end it. This judges duration instead, which is the one signal a loud wedge cannot fake.
 */
export function turnBudgetExhausted(input: TurnBudgetInput): boolean {
  return input.now - input.startedAt >= input.budgetMs
}

/**
 * How long the next liveness tick may sleep: the sampling interval, cut short by the turn's
 * wall-clock deadline.
 *
 * The budget is only ever judged *after* a tick resolves, so a sampling interval longer than the
 * remaining budget would leave the budget unread until the interval elapsed — and
 * `LIVENESS_SAMPLE_INTERVAL_MS` is a configurable value that may legitimately exceed it. Clamping
 * here keeps the deadline the thing that decides when the turn is next judged.
 *
 * A zero delay is a fine answer, not a degenerate one: the tick fires at once and that same pass
 * reads the budget as exhausted.
 */
export function nextSampleDelay(input: {
  intervalMs: number
  startedAt: number
  budgetMs: number
  now: number
}): number {
  return Math.max(0, Math.min(input.intervalMs, input.startedAt + input.budgetMs - input.now))
}

/**
 * The `await-exit` step's own ceiling, as one number.
 *
 * The platform aborts a step that outlives it, and that abort is the outcome AC-026 reserves for
 * the watchdog: no kill, no `reportComplete`, no `timedOutBy`. Every deadline the step judges is
 * therefore expressed against this one value rather than beside it, so the two cannot drift into
 * a budget the step can no longer outlast.
 */
export const AWAIT_EXIT_STEP_TIMEOUT_MS = 6 * 60 * 60 * 1000

/**
 * The same ceiling in the spelling `WorkflowStepConfig.timeout` takes.
 *
 * A duration string rather than {@link AWAIT_EXIT_STEP_TIMEOUT_MS} itself, because the field also
 * accepts a bare number and the unit a bare number carries is not something to infer — getting it
 * wrong would silently move the step's real timeout. `watchdog.test.ts` pins this literal against
 * the number, so the pair is checked rather than merely written next to each other.
 */
export const AWAIT_EXIT_STEP_TIMEOUT = '6 hours'

/** What the step keeps for itself: the kill, the final log drain, and the closing flush. */
export const TURN_BUDGET_MARGIN_MS = 60 * 60 * 1000

/**
 * The most wall clock a turn may be given, one margin short of the step's own ceiling.
 *
 * A configured `TURN_WALL_CLOCK_BUDGET_MS` at or above the step timeout would hand the verdict
 * back to the platform, which is exactly what {@link AWAIT_EXIT_STEP_TIMEOUT_MS} says must not
 * happen. Derived rather than written out, so raising the step's ceiling raises this with it.
 *
 * The margin is not slack: once the budget fires, the step still has to kill the process, drain
 * the log one last time and put the closing snapshot, and all of that has to finish inside the
 * step.
 */
export const MAX_TURN_WALL_CLOCK_BUDGET_MS = AWAIT_EXIT_STEP_TIMEOUT_MS - TURN_BUDGET_MARGIN_MS

/**
 * The configured budget, held below {@link MAX_TURN_WALL_CLOCK_BUDGET_MS} and loud about it.
 *
 * Clamped rather than rejected at config time: a misconfigured deployment still runs its turns,
 * one margin short of the ceiling, instead of failing every run over a number.
 */
export function clampedTurnBudget(configured: number): number {
  if (configured <= MAX_TURN_WALL_CLOCK_BUDGET_MS) {
    return configured
  }
  console.warn(
    `turn wall-clock budget clamped configured_ms=${configured} applied_ms=${MAX_TURN_WALL_CLOCK_BUDGET_MS}`,
  )
  return MAX_TURN_WALL_CLOCK_BUDGET_MS
}

/**
 * Which of the watchdog's two timers has fired, or `undefined` while the turn may keep running.
 *
 * Silence is asked first and the budget only after it, so a turn that went quiet *and* ran long
 * is reported as the wedge it is; the budget is the fallback for the case silence cannot see —
 * a turn still printing after hours of no progress (#358).
 *
 * The two watchdog thresholds arrive as scalars rather than as the whole `TurnDriverConfig`,
 * so the *unclamped* `config.turnWallClockBudgetMs` is not in reach beside the clamped `budgetMs`
 * — reaching for the wrong one would silently bypass {@link MAX_TURN_WALL_CLOCK_BUDGET_MS}.
 *
 * It lives here rather than beside one driver's loop because both drivers make the same
 * decision from different observations: the `cli` driver counts bytes off a log cursor, the
 * `sdk` driver counts frame arrivals off a socket, and D4 says the decision itself is unchanged
 * between them.
 */
export function turnTimeoutCause(input: {
  startedAt: number
  lastLogActivityAt: number
  now: number
  budgetMs: number
  watchdogTimeoutMs: number
  livenessWindowMs: number
}): TurnTimeoutCause | undefined {
  const silence = watchdogDecision({
    lastLogActivityAt: input.lastLogActivityAt,
    now: input.now,
    watchdogTimeoutMs: input.watchdogTimeoutMs,
    livenessWindowMs: input.livenessWindowMs,
  })
  if (silence === 'timeout') {
    return 'watchdog'
  }
  return turnBudgetExhausted({ startedAt: input.startedAt, now: input.now, budgetMs: input.budgetMs })
    ? 'budget'
    : undefined
}

/**
 * How long one `sdk` attach round consumes frames before it returns and the next step re-attaches.
 *
 * The round is what keeps a six-hour turn under the per-step CPU meter, and what makes an
 * eviction cheap: the next round re-attaches with the `since` it stored and the host's journal
 * fills the gap. Twenty minutes is the ADR's starting figure.
 *
 * A round that ends on its own window rather than on a frame is the ordinary case, not a stall.
 * With `emitDeltas: false` liveness comes from complete messages and the CLI's `tool_progress`
 * (about every 30 s), so a healthy turn resets the silence clock many times inside one window —
 * but the window is what bounds the *step*, not what judges the turn, and the silence and budget
 * timers below are what say whether it may continue.
 */
export const ROUND_WINDOW_MS = 20 * 60 * 1000

/**
 * The round step's own ceiling, in the spelling `WorkflowStepConfig.timeout` takes.
 *
 * Half again the window, so a round that is draining its mirror or settling an interrupt when
 * the window ends is not aborted by the platform mid-decision — the same margin
 * {@link TURN_BUDGET_MARGIN_MS} keeps for the single-step driver, at the round's scale.
 */
export const ROUND_STEP_TIMEOUT = '30 minutes'

/**
 * How many rounds one turn may take before the loop stops asking.
 *
 * Derived from the budget rather than configured: the budget is what ends a turn, and a round
 * count that could not cover it would end turns on an arithmetic detail instead. The `+ 2` is
 * the round that observes the budget and the one that settles the interrupt after it.
 */
export function maxAttachRounds(budgetMs: number): number {
  return Math.ceil(budgetMs / ROUND_WINDOW_MS) + 2
}
