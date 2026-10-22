import { describe, expect, it, vi } from 'vitest'
import {
  AWAIT_EXIT_STEP_TIMEOUT_MS,
  clampedTurnBudget,
  MAX_TURN_WALL_CLOCK_BUDGET_MS,
  maxAttachRounds,
  ROUND_STEP_TIMEOUT,
  ROUND_WINDOW_MS,
  turnBudgetExhausted,
  watchdogDecision,
} from './watchdog'

const SECOND = 1000

/** A watchdog that fires after 5 minutes of silence, counting activity in the last minute as alive. */
const WATCHDOG_TIMEOUT_MS = 300 * SECOND
const LIVENESS_WINDOW_MS = 60 * SECOND

describe('watchdogDecision', () => {
  it('extends the wait when the process logged inside the liveness window', () => {
    const decision = watchdogDecision({
      lastLogActivityAt: 1_000_000,
      now: 1_000_000 + 30 * SECOND,
      watchdogTimeoutMs: WATCHDOG_TIMEOUT_MS,
      livenessWindowMs: LIVENESS_WINDOW_MS,
    })
    expect(decision).toBe('extend')
  })

  it('times out when nothing was logged past the watchdog timeout', () => {
    const decision = watchdogDecision({
      lastLogActivityAt: 1_000_000,
      now: 1_000_000 + 301 * SECOND,
      watchdogTimeoutMs: WATCHDOG_TIMEOUT_MS,
      livenessWindowMs: LIVENESS_WINDOW_MS,
    })
    expect(decision).toBe('timeout')
  })

  it('treats the liveness-window boundary as still alive', () => {
    const decision = watchdogDecision({
      lastLogActivityAt: 1_000_000,
      now: 1_000_000 + LIVENESS_WINDOW_MS,
      watchdogTimeoutMs: LIVENESS_WINDOW_MS,
      livenessWindowMs: LIVENESS_WINDOW_MS,
    })
    expect(decision).toBe('extend')
  })

  it('times out exactly on the watchdog timeout once the liveness window has passed', () => {
    const decision = watchdogDecision({
      lastLogActivityAt: 1_000_000,
      now: 1_000_000 + WATCHDOG_TIMEOUT_MS,
      watchdogTimeoutMs: WATCHDOG_TIMEOUT_MS,
      livenessWindowMs: LIVENESS_WINDOW_MS,
    })
    expect(decision).toBe('timeout')
  })

  it('keeps waiting while the silence is longer than the liveness window but shorter than the timeout', () => {
    const decision = watchdogDecision({
      lastLogActivityAt: 1_000_000,
      now: 1_000_000 + 90 * SECOND,
      watchdogTimeoutMs: WATCHDOG_TIMEOUT_MS,
      livenessWindowMs: LIVENESS_WINDOW_MS,
    })
    expect(decision).toBe('extend')
  })

  it('extends rather than killing when the activity timestamp is ahead of now', () => {
    const decision = watchdogDecision({
      lastLogActivityAt: 1_000_000 + 5 * SECOND,
      now: 1_000_000,
      watchdogTimeoutMs: WATCHDOG_TIMEOUT_MS,
      livenessWindowMs: LIVENESS_WINDOW_MS,
    })
    expect(decision).toBe('extend')
  })
})

/** A turn allowed two hours of wall clock, however loudly it spends them. */
const TURN_WALL_CLOCK_BUDGET_MS = 2 * 60 * 60 * SECOND

describe('turnBudgetExhausted', () => {
  it('leaves a turn inside its budget alone', () => {
    expect(turnBudgetExhausted({
      startedAt: 1_000_000,
      now: 1_000_000 + TURN_WALL_CLOCK_BUDGET_MS - SECOND,
      budgetMs: TURN_WALL_CLOCK_BUDGET_MS,
    })).toBe(false)
  })

  it('cuts the turn off exactly on the budget', () => {
    expect(turnBudgetExhausted({
      startedAt: 1_000_000,
      now: 1_000_000 + TURN_WALL_CLOCK_BUDGET_MS,
      budgetMs: TURN_WALL_CLOCK_BUDGET_MS,
    })).toBe(true)
  })

  it('cuts off a turn that has run past its budget', () => {
    expect(turnBudgetExhausted({
      startedAt: 1_000_000,
      now: 1_000_000 + 209 * 60 * SECOND,
      budgetMs: TURN_WALL_CLOCK_BUDGET_MS,
    })).toBe(true)
  })
})

describe('the turn budget ceiling and the step timeout it is derived from', () => {
  /**
   * The whole point of deriving one from the other: a turn that outlasts its step hands the
   * verdict to the platform, which aborts with no kill, no `reportComplete` and no `timedOutBy`.
   */
  it('leaves the step a margin the budget can never eat into', () => {
    expect(MAX_TURN_WALL_CLOCK_BUDGET_MS).toBeLessThan(AWAIT_EXIT_STEP_TIMEOUT_MS)
    expect(AWAIT_EXIT_STEP_TIMEOUT_MS - MAX_TURN_WALL_CLOCK_BUDGET_MS).toBe(60 * 60 * SECOND)
  })
})

describe('clampedTurnBudget', () => {
  it('passes a configured budget inside the ceiling through untouched', () => {
    expect(clampedTurnBudget(TURN_WALL_CLOCK_BUDGET_MS)).toBe(TURN_WALL_CLOCK_BUDGET_MS)
  })

  it('clamps a budget at or past the ceiling, and says so', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(clampedTurnBudget(AWAIT_EXIT_STEP_TIMEOUT_MS)).toBe(MAX_TURN_WALL_CLOCK_BUDGET_MS)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('turn wall-clock budget clamped'))

    warn.mockRestore()
  })
})

describe('attach rounds', () => {
  it('leaves a round\'s step a margin past the window it consumes frames for', () => {
    expect(ROUND_STEP_TIMEOUT).toBe(`${(ROUND_WINDOW_MS * 1.5) / (60 * SECOND)} minutes`)
  })

  /*
   * The budget is what ends a turn; a round count that could not cover it would end turns on an
   * arithmetic detail instead — which is why the loop treats exhaustion as a wedge, not a budget.
   */
  it('covers the whole budget with rounds to spare, whatever the budget is', () => {
    for (const budgetMs of [ROUND_WINDOW_MS / 2, ROUND_WINDOW_MS, MAX_TURN_WALL_CLOCK_BUDGET_MS]) {
      expect(maxAttachRounds(budgetMs) * ROUND_WINDOW_MS).toBeGreaterThan(budgetMs)
    }
    expect(maxAttachRounds(MAX_TURN_WALL_CLOCK_BUDGET_MS)).toBe(17)
  })
})
