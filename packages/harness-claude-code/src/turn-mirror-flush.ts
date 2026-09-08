/**
 * The live transcript mirror's publishing cadence, shared by both drivers.
 *
 * Split out of `cli-turn-watch.ts` when the `sdk` driver arrived, because the two drivers watch
 * a turn very differently — a log cursor against a socket — and publish it identically: the
 * mirror re-puts a whole snapshot on a slow tick, and how slow that tick is is a property of R2
 * and of the isolate's memory, not of how the bytes were observed.
 */
import type { LiveMirror } from './mirror'
import { boundedFlush, LIVE_MIRROR_FLUSH_TIMEOUT_MS } from './mirror'

/**
 * How often the live transcript mirror re-puts its snapshot while the turn runs.
 *
 * R2 has no append, so every flush writes the whole snapshot and the interval is a cost, not a
 * cadence: five minutes is a handful of puts across a long turn. The worst case is losing one
 * interval of tail — the bytes appended since the last flush — and only if the workflow itself
 * dies, since every exit path of a wait — and every attach round — drains and flushes
 * before it returns.
 */
const LIVE_MIRROR_FLUSH_INTERVAL_MS = 5 * 60 * 1000

/**
 * Publish a snapshot when the interval has elapsed, and answer when the next one is due from.
 *
 * Returns the unchanged `lastFlushAt` when nothing was written, so the interval measures time
 * between actual puts rather than between ticks.
 */
export async function flushOnInterval(
  mirror: LiveMirror | undefined,
  lastFlushAt: number,
  now: number,
  processId: string,
): Promise<number> {
  if (mirror === undefined || now - lastFlushAt < LIVE_MIRROR_FLUSH_INTERVAL_MS) {
    return lastFlushAt
  }
  // Bounded for the reason the log read is: the deadline decision this loop makes next is only
  // reached once this returns, so a stalled put must not be able to postpone it.
  await boundedFlush(mirror, { final: false, ended: false }, LIVE_MIRROR_FLUSH_TIMEOUT_MS, processId)
  return now
}
