/**
 * Pushing the sandbox's stop-clock back while a turn is still running.
 *
 * A port of `@amond-ai/sandbox-e2b`'s module of the same name — same rate limiter, same
 * stamp-before-the-call ordering, same swallow-but-log — with one semantic correction that
 * cannot be skipped, because the two APIs mean opposite things by the same word.
 *
 * e2b's `setTimeout(ms)` **re-applies** a lifetime: it restarts the countdown from now, so
 * calling it with the same value at any cadence simply keeps the sandbox a lifetime away from
 * stopping. Vercel's `extendTimeout(ms)` **adds** to the current deadline, and the sum is capped
 * by the plan's maximum execution timeout. A naive port pushes the deadline further out on every
 * renewal, and then — for the rest of a long turn, which is exactly when this matters — fails
 * against that cap on every call, logging a failure per probe while the deadline it was meant to
 * protect stops moving.
 *
 * So the deadline is tracked here and the extension is *skipped* while there is still more than
 * half an increment left on it. The sandbox therefore sits between half an increment and one and
 * a half increments from stopping, never further, and a long turn pays a handful of calls rather
 * than one per liveness probe.
 *
 * **The lifetime and the increment are two numbers, not one.** A sandbox created with 30 minutes
 * whose plan caps a single `extendTimeout` at 5 is an ordinary configuration, and collapsing the
 * pair re-creates the exact accumulation this module exists to prevent: seeding the deadline from
 * the *increment* would put it at `now + 5min` against a sandbox that stops at `now + 30min`,
 * so the renewer would start extending 27.5 minutes early and then again every increment/4 for
 * the rest of the turn — one call per 75 seconds, every one of them adding to a sum the plan is
 * about to refuse.
 */
import type { VercelSandboxLike } from './vercel-surface'

/**
 * How many renewals fit inside one extension's worth of headroom.
 *
 * Four, so three attempts remain after one fails and the sandbox still outlives the turn, while
 * a long turn pays a handful of `extendTimeout` calls rather than one per liveness probe.
 */
const RENEWALS_PER_LIFETIME = 4

export interface LifetimeRenewal {
  /**
   * Lifetime the sandbox was created with, in milliseconds. Unset disables renewal entirely.
   *
   * Seeds the deadline, and nothing else — how far each renewal pushes that deadline is
   * {@link incrementMs}. Taken from the provider's configured timeout rather than chosen here,
   * and absent means absent: a consumer that did not set a lifetime did not ask this package to
   * manage one, and inventing a deadline for a sandbox whose owner deliberately left it unbounded
   * is not a default this can pick.
   */
  initialLifetimeMs?: number
  /**
   * What one `extendTimeout` call adds, in milliseconds. Defaults to {@link initialLifetimeMs}.
   *
   * Set it when the plan's cap on a single extension is below the lifetime the sandbox was
   * created with. It sizes both the skip window and the rate limit, because both are questions
   * about the extension rather than about the lifetime: how much headroom one call buys, and how
   * often one is worth making.
   */
  incrementMs?: number
  /** The shortest gap this will ever leave between two renewals. */
  floorMs: number
  /**
   * Monotonic milliseconds. Injected only so a wait's deadline — and the absence of one — can be
   * exercised without spending the wall-clock time it would otherwise take.
   */
  elapsedMs: () => number
}

/** The shortest gap between two renewals that each buy `increment` of headroom. */
function renewalIntervalMs(increment: number, floorMs: number): number {
  return Math.max(floorMs, increment / RENEWALS_PER_LIFETIME)
}

/**
 * A renewal call that may be made as often as the caller likes.
 *
 * Vercel stops a sandbox at its deadline regardless of what is running inside it, and the run
 * workflow tolerates a live turn for six hours against a lifetime set in minutes. Failure is
 * swallowed because a renewal that did not land is not a reason to abandon a wait over a healthy
 * process — but it is logged, since a silently unrenewed sandbox is the exact failure this call
 * exists to prevent.
 *
 * Rate-limited against the lifetime rather than the caller's cadence: `waitForExit` asks on every
 * liveness probe, and renewing an hourly lifetime every five seconds is thousands of remote round
 * trips for one turn, all but a handful of them redundant. The state is per session, not per
 * wait, because the sandbox is one — two concurrent waits renewing it separately would buy
 * nothing.
 */
export function createLifetimeRenewer(
  sandbox: VercelSandboxLike,
  options: LifetimeRenewal,
): () => Promise<void> {
  /** When the lifetime was last pushed back, so a wait does not renew once per probe. */
  let renewedAt: number | undefined
  /**
   * Where the deadline currently stands, on {@link LifetimeRenewal.elapsedMs}'s clock.
   *
   * Seeded from `sandbox.expiresAt` when the API reported one, and that is the authoritative
   * seed: the consumer declares the lifetime in two places — `VercelApiOptions.create.timeout`
   * and {@link LifetimeRenewal.initialLifetimeMs} — and nothing checks that the two agree.
   *
   * The configured lifetime is the fallback, and it is the weaker one, because the error it
   * admits is not symmetric. A seed that is *shorter* than the truth renews sooner than necessary
   * and costs a call; a seed that is *longer* — a consumer declaring 30 minutes against a sandbox
   * really created with 5 — believes in headroom that is not there and lets the sandbox stop in
   * the middle of a turn. Reading the real deadline removes that direction entirely rather than
   * the harmless one.
   *
   * Either way it is only ever used to *skip* a call, never to decide that a renewal failed or
   * that a turn should end.
   */
  let deadlineAt: number | undefined

  /** Milliseconds until Vercel's own stop time, when it reported one. */
  function reportedRemainingMs(): number | undefined {
    const expires = sandbox.expiresAt
    if (expires === undefined) {
      return undefined
    }
    const remaining = expires.getTime() - Date.now()
    return Number.isFinite(remaining) ? remaining : undefined
  }

  return async () => {
    const lifetime = options.initialLifetimeMs
    if (lifetime === undefined) {
      return
    }
    const increment = options.incrementMs ?? lifetime
    const at = options.elapsedMs()
    deadlineAt ??= at + (reportedRemainingMs() ?? lifetime)
    if (renewedAt !== undefined && at - renewedAt < renewalIntervalMs(increment, options.floorMs)) {
      return
    }
    // The correction this port exists for: `extendTimeout` adds, so asking again while the
    // deadline is still most of an extension away pushes it past the plan's cap and turns every
    // later renewal into a refusal. Half an increment of headroom is what keeps the sandbox
    // comfortably alive without ever accumulating.
    if (deadlineAt - at > increment / 2) {
      return
    }
    // Stamped before the call, not after it: an API that is refusing `extendTimeout` would
    // otherwise be asked again on every probe, which is the cadence this exists to stop. A
    // quarter-increment interval still leaves three further attempts before it expires.
    renewedAt = at
    try {
      await sandbox.extendTimeout(increment)
      // Advanced only once the extension landed. Moving it on a refusal would make the skip
      // above believe in headroom the sandbox does not have, and the next renewal would be
      // skipped for half an increment that is not there.
      deadlineAt += increment
    }
    catch (error) {
      console.warn(`sandbox-vercel: could not renew sandbox lifetime: ${String(error)}`)
    }
  }
}
