/**
 * The slice of a deployment's config one turn is judged by — every field the driver reads, and
 * nothing else.
 *
 * A structural subset rather than the orchestrator's own `TurnDriverConfig`, which is what lets
 * this package be lifted out of `apps/cf-orchestrator` at all: the app passes its config straight
 * through and TypeScript checks the fit, so a field renamed on either side fails `check` instead
 * of drifting. Every value here is a *threshold or a posture*, never a binding — a driver decides
 * how long to wait and what to allow, and is handed everything it needs to reach a container.
 */
export interface TurnDriverConfig {
  watchdogTimeoutMs: number
  livenessWindowMs: number
  /** Wall-clock ceiling on one turn, independent of whether it is still logging (#358). */
  turnWallClockBudgetMs: number
  /**
   * Ceiling on one turn's spend in USD, and on how many agent turns it may take.
   *
   * Both absent by default — and absent means *no limit*. The `sdk` driver puts them on the
   * `start` frame; the `cli` driver ignores both.
   */
  turnMaxBudgetUsd?: number
  turnMaxTurns?: number
  /**
   * The run's permission posture, as tool-name patterns (D6). Both empty by default — an empty
   * list is "this deployment names none", and the `sdk` driver then puts no such field on its
   * `start` frame at all. The `cli` driver ignores both.
   */
  turnDeferTools: readonly string[]
  turnRefuseTools: readonly string[]
  livenessSampleIntervalMs: number
  /** Where a turn runs, and what a turn host's state directory is derived from. */
  workspaceRoot: string
}
