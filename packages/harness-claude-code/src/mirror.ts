/**
 * Where a turn's bytes go while it runs — the sink's *interface*, not its implementation.
 *
 * The driver appends to a mirror and flushes it on a cadence; it never learns what is behind
 * one. The orchestrator's `live-mirror.ts` builds the R2-backed instance (masking included) and
 * hands it in, which is what keeps this package free of both a bucket binding and the transcript
 * masking rules that belong to the record rather than to the turn.
 */

/**
 * The hard ceiling on what one live mirror holds in memory, past which it stops appending and
 * stamps the object truncated.
 *
 * Counted against the *ingested* UTF-8 bytes rather than the assembled text, which is the
 * conservative direction for the record: masking only ever shrinks a line, so the stored snapshot
 * is never larger than what this measured. It is not conservative for *memory*, which is why the
 * number is 16 MiB rather than the 32 it started at. The held string is UTF-16 the moment any
 * character outside Latin-1 appears — routine in `stream-json`, where a turn's own output is
 * quoted back — so 16 MiB ingested is up to ~32 MB resident, and every put encodes that whole
 * snapshot again for the body, adding ~16 MB for the duration of the write. That fits inside a
 * 128 MB isolate with room to spare beside everything else the workflow holds; 32 MiB did not.
 *
 * **The cap truncates from the head**: appending stops, so what is kept is the *beginning* of the
 * turn and the tail past the cap is lost. Accepted rather than solved. A turn inside its
 * wall-clock budget emits a few megabytes, so nothing healthy reaches this; a turn that crosses it
 * is the runaway case, its record is stamped `truncated` for whoever reads it, and the beginning
 * of a runaway is the half that says how it started going wrong.
 */
export const LIVE_MIRROR_MAX_BYTES = 16 * 1024 * 1024

/** The live mirror, as `awaitTurn` drives it. */
export interface LiveMirror {
  /**
   * Take one `stdout` event's bytes and the cursor it was delivered at. Never throws; nothing
   * here may fail a turn.
   */
  append: (data: Uint8Array, cursor: string) => void
  /** Record that bytes were lost — a failed log read — so the object is stamped truncated. */
  noteGap: () => void
  /**
   * Write the snapshot.
   *
   * A non-final flush publishes only the record's exact prefix — everything through the last
   * event that ended on a line boundary — with that event's cursor. A final flush publishes
   * everything, trailing fragment included, and closes the record.
   *
   * `ended` is what the object is stamped `complete` with, and it defaults to `final` only
   * because a non-final flush is never complete. The two are *not* the same fact: `final` says
   * this is the last flush this instance will make, while `complete` claims the turn's process
   * is over — the claim `hasCompleteLiveRecord` makes the settle replay stand down for. A step
   * that gave up waiting on a live process makes a final flush over a turn that is still
   * running, and the caller passes `ended: false` for it (see `awaitTurn`).
   *
   * Never rejects, and never lets two puts race: a non-final flush issued while an earlier put
   * is still in flight returns without writing, and a final one waits for that put first.
   */
  flush: (final: boolean, ended?: boolean) => Promise<void>
  /** Bytes ingested so far, for tests and for reasoning about the cap. */
  readonly bytes: number
  /**
   * The cursor of the last event taken, or `undefined` before the first one.
   *
   * `awaitTurn` starts its first log read here, which is what makes a seeded mirror resume
   * rather than re-read: the cursor stored with a put is the cursor of the text in that put, so a
   * resumed mirror reads on from it. Note that this is the *latest* cursor, which a non-final put
   * deliberately does not use — see {@link flush}.
   */
  readonly cursor: string | undefined
}

/**
 * How long the live record's own R2 calls may take before the workflow stops waiting on them.
 *
 * One definition for both directions of the same object: the resume read at step entry
 * ({@link resumeLiveTranscript}) and the snapshot puts the mirror makes while the turn runs
 * (`boundedFlush`). Generous on purpose — a 16 MiB snapshot has to fit through it — because what
 * it bounds is not the call but the workflow's *wait* for it: the watchdog loop judges the turn's
 * wall-clock deadline only after these return, so an unbounded one would hold a turn past its
 * budget until the platform's step timeout aborted the step.
 */
export const LIVE_MIRROR_FLUSH_TIMEOUT_MS = 120_000

/**
 * Flush the mirror, but stop waiting for it after `timeoutMs`.
 *
 * The watchdog loop judges the turn's wall-clock deadline only *after* its flush returns, so a
 * put that stalled would hold the turn there — the same shape the bounded log read closes, one
 * R2 call further along. The bound is on the *wait*, not on the put: the put keeps going and may
 * still land, which is why the mirror's own in-flight guard exists — the next tick will not race
 * it, it will skip.
 *
 * Nothing is reported back. {@link LiveMirror.flush} never rejects, and a snapshot that did not
 * land in time is not a fact about the turn — the next flush re-puts the same snapshot, and the
 * settle replay arbitrates whatever is finally stored.
 */
export async function boundedFlush(
  mirror: LiveMirror,
  mode: { final: boolean, ended: boolean },
  timeoutMs: number,
  processId: string,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let expired = false
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true
      resolve()
    }, timeoutMs)
  })
  try {
    await Promise.race([mirror.flush(mode.final, mode.ended), expiry])
    if (expired) {
      console.warn(`live transcript flush abandoned process_id=${processId} after_ms=${timeoutMs}`)
    }
  }
  finally {
    // Cleared whichever side won, so a flush that returned first leaves no timer behind — the
    // rule `sampleTick` and `readDeadline` already follow.
    clearTimeout(timer)
  }
}
