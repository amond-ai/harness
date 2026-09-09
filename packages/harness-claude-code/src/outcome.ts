/**
 * How one turn ended, in the vocabulary both drivers and the attempt loop share.
 *
 * Here rather than in the orchestrator's `run-state.ts` because the driver is what produces
 * these values: the loop's classifiers (`FailingAttemptOutcome`, `failureCategoryFor`) are built
 * on top of them and stay with the run's state machine, which re-exports these so nothing that
 * reached for them there had to move.
 */

/**
 * How a single `claude` turn ended. `timed-out` is the watchdog's verdict, not the process's.
 *
 * `deferred` is the odd one out and deliberately so: it is not an ending the run can be reported
 * on. The turn stopped because a tool call needs a human's answer, so the attempt loop always
 * follows it with a wait and another attempt — see `FailingAttemptOutcome`, which types it out of
 * the failure classifier, and `shouldStopAttemptLoop`, which never lets the loop end on it.
 */
export const ATTEMPT_OUTCOMES = ['succeeded', 'failed', 'timed-out', 'deferred'] as const

export type AttemptOutcome = typeof ATTEMPT_OUTCOMES[number]

/**
 * Which timer ended a `timed-out` turn.
 *
 * Both are the watchdog's verdict, and they answer different questions: `watchdog` is the
 * silence timer — the turn stopped producing output — while `budget` is the wall clock, which
 * cuts off a turn that is still printing but has run too long (#358). The distinction is worth a
 * value rather than a comment because it changes what the next attempt should be told: "you went
 * quiet" and "you took too long" call for different corrections.
 */
export const TURN_TIMEOUT_CAUSES = ['watchdog', 'budget'] as const

export type TurnTimeoutCause = typeof TURN_TIMEOUT_CAUSES[number]

/**
 * What the *turn* said about its own ending, as opposed to what its host's exit said (#376).
 *
 * The two answer different questions and can disagree: a turn that reported `subtype: 'success'`
 * from a host that then exited non-zero did the work, and an exit-0 `is_error` is a turn that
 * could not. Settle has read the turn's word ahead of the exit code since D5; this is the same
 * word, projected small enough to ride an attempt's result so the loop can read it too.
 *
 * Three fields and no text. `subtype` and `isError` are the judgment; `terminalReason` is here for
 * exactly one value — `tool_deferred`, the ending that is a pending question rather than a failure
 * and must never be read as a transient one to retry. The agent's own prose stays out: it is the
 * settle replay's to record, and the loop decides nothing with it.
 */
export interface TurnVerdict {
  /** `SDKResultMessage.subtype`, verbatim; `success` is the only value anything branches on. */
  subtype: string
  /** The agent's own "I could not do this", which an exit code cannot show. */
  isError: boolean
  /** Why the terminal state was reached (`tool_deferred`, `max_turns`, …); absent on older CLIs. */
  terminalReason?: string
}

/**
 * The one narrowing of an untrusted value to a timeout cause.
 *
 * Two readers need it and they must not drift: a run result read back through JSON
 * (`workflow-result.ts`) and the turn host's echoed interrupt reason, which is a wider
 * vocabulary than this one (`sdk/sdk-round-state.ts`). Anything outside the list is
 * `undefined` rather than an error — both callers have a meaning for "no cause named".
 */
export function asTurnTimeoutCause(value: unknown): TurnTimeoutCause | undefined {
  return typeof value === 'string' && (TURN_TIMEOUT_CAUSES as readonly string[]).includes(value)
    ? value as TurnTimeoutCause
    : undefined
}
