/**
 * Pushing the sandbox's stop-clock back while a turn is still running.
 *
 * Split out of `e2b-session.ts`, which is at the 500-LOC limit the repository sets. This is
 * the seam that costs the least to cut: nothing here reads the journal or e2b's process
 * table, so it carries none of the trust reasoning the rest of the backend turns on — it is
 * one rate-limited call and the state that rate-limits it.
 */
import type { E2bSandboxLike } from './e2b-surface'

/**
 * How many renewals fit inside one sandbox lifetime.
 *
 * Four, so three attempts remain after one fails and the sandbox still outlives the turn,
 * while a long turn pays a handful of `setTimeout` calls rather than one per liveness probe.
 */
const RENEWALS_PER_LIFETIME = 4

export interface LifetimeRenewal {
  /**
   * Lifetime re-applied to the sandbox, in milliseconds. Unset disables renewal.
   *
   * Taken from the provider's configured `timeoutMs` rather than chosen here, so the
   * lifetime that gets renewed is the one the sandbox was created with.
   */
  lifetime?: number
  /** The shortest gap this will ever leave between two renewals. */
  floorMs: number
  /**
   * Monotonic milliseconds. Injected only so a wait's deadline — and the absence of one —
   * can be exercised without spending the wall-clock time it would otherwise take.
   */
  elapsedMs: () => number
}

/** The shortest gap between two renewals of a `lifetime`-long sandbox. */
function renewalIntervalMs(lifetime: number, floorMs: number): number {
  return Math.max(floorMs, lifetime / RENEWALS_PER_LIFETIME)
}

/**
 * A renewal call that may be made as often as the caller likes.
 *
 * e2b stops a sandbox at its configured lifetime regardless of what is running inside it,
 * and the run workflow tolerates a live turn for six hours against a lifetime set in
 * minutes. Failure is swallowed because a renewal that did not land is not a reason to
 * abandon a wait over a healthy process — but it is logged, since a silently unrenewed
 * sandbox is the exact failure this call exists to prevent.
 *
 * Rate-limited against the lifetime rather than the caller's cadence: `waitForExit` asks on
 * every liveness probe, and renewing an hourly lifetime every five seconds is ~4,300 remote
 * round trips for one turn, all but a handful of them redundant (gemini review, PR #260).
 * The state is per session, not per wait, because the sandbox is one — two concurrent waits
 * renewing it separately would buy nothing.
 */
export function createLifetimeRenewer(
  sandbox: E2bSandboxLike,
  options: LifetimeRenewal,
): () => Promise<void> {
  /** When the lifetime was last pushed back, so a wait does not renew once per probe. */
  let renewedAt: number | undefined

  return async () => {
    const lifetime = options.lifetime
    if (lifetime === undefined) {
      return
    }
    const at = options.elapsedMs()
    if (renewedAt !== undefined && at - renewedAt < renewalIntervalMs(lifetime, options.floorMs)) {
      return
    }
    // Stamped before the call, not after it: an e2b that is refusing `setTimeout` would
    // otherwise be asked again on every probe, which is the cadence this exists to stop.
    // A quarter-lifetime interval still leaves three further attempts before it expires.
    renewedAt = at
    try {
      await sandbox.setTimeout(lifetime)
    }
    catch (error) {
      console.warn(`sandbox-e2b: could not renew sandbox lifetime: ${String(error)}`)
    }
  }
}
