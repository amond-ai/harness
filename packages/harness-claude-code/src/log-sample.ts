/**
 * One bounded cursor read of a running turn's process log — the watchdog's liveness measurement,
 * and the live mirror's only source of the turn's output while it is still running.
 *
 * Split out of `run-workflow.ts` so `bun test` can reach it: that module imports
 * `cloudflare:workers` through `agents`, while everything here is the sandbox contract's
 * `process.logs()` and a timer. Nothing in this file's imports resolves only inside workerd.
 *
 * **The read is bounded, which is the whole reason it is worth its own module.** `watchTurn`
 * judges the turn's wall-clock deadline only *after* a read returns, so a `logs()` call that
 * stalls blocks the decision it gates — a degraded log backend could hold a turn past
 * `TURN_WALL_CLOCK_BUDGET_MS` until the platform's 6-hour `await-exit` step timeout aborted the
 * step, with no kill and no `timedOutBy`.
 */
import type { SandboxProcessHandle } from '@amond-ai/sandbox'
import type { LiveMirror } from './mirror'
import { describeCause } from '@amond-ai/redact'
import { iterateStream } from './process-ndjson'

/**
 * How long one cursor read may take before it is abandoned where it got to.
 *
 * A positioned read of a finite batch normally takes milliseconds, so a minute is not a threshold
 * anything healthy approaches. It is not a liveness signal about the *process*: a turn that has
 * printed nothing for a minute is judged by the watchdog's own timers, not by this. What this
 * bounds is the orchestrator's own reachability of the log backend, so that a stalled read cannot
 * postpone the wall-clock budget decision indefinitely.
 */
export const LOG_READ_TIMEOUT_MS = 60_000

/** One finite cursor batch used by the liveness watchdog. */
export interface LogSample {
  cursor?: string
  bytes: number
}

/**
 * What the streaming loop has taken so far, shared with the deadline so an abandoned read can
 * report its own partial progress and stop appending.
 */
interface ReadProgress {
  cursor?: string
  bytes: number
  /**
   * Aborted by the deadline. The loop stops at the next event it sees and appends nothing more,
   * and the backend is handed the same signal so it ends the stream from its side.
   */
  stop: AbortController
}

/**
 * Read the finite log batch after the previous cursor, count its output bytes, and hand the
 * `stdout` half to the live mirror on its way past.
 *
 * The counting is what the watchdog judges liveness on and is unchanged. The mirror is the #358
 * addition and is why this no longer only counts: these reads are the only place the turn's whole
 * output is still available, since the container's own retention caps what a settle-time replay
 * can read back. `stderr` is counted but not mirrored, matching `demuxProcessEvents` — the settle
 * path stores stdout alone, and the two writers share one key.
 *
 * **A `truncated` event is deliberately not a gap here.** The contract defines it as the process
 * resource reporting that *earlier* log output was discarded — a statement about the container's
 * retained log, which is what a settle-time replay reads. This reader has followed the stream by
 * cursor since before that discard, so it already holds the output the event announces and its
 * record loses nothing. Stamping it truncated would only make the live record stand down for a
 * replay that is the very fragment the event is warning about. In this record, a gap is a read
 * that failed, and nothing else.
 *
 * A failed read reports what it reached rather than throwing, because this runs inside the
 * NO_RETRIES `await-exit` step (PR-72 review), and tells the mirror that bytes were lost. It keeps
 * the cursor the batch *did* reach rather than rewinding to `previous.cursor`: the events before
 * the failure were already handed to the mirror, and re-reading them from the old cursor would
 * append them a second time — the stored transcript would carry each of those lines twice.
 *
 * Repeated *total* failures deliberately look like silence: AC-026 judges a wedge by observed
 * liveness, and output the orchestrator cannot observe is not liveness. A batch that failed
 * part-way through still reports the bytes it did deliver, though — those were observed, and were
 * already handed to the mirror, so reporting zero for them would let a transport hiccup mid-batch
 * read as a wedge on a turn that is plainly alive. `iterateStream` drains the batch and cancels
 * its reader if iteration exits abnormally.
 *
 * **A read that failed before it moved is not a gap either.** `process.logs()` can reject on its
 * own — an unreachable backend, a refused request — with no event taken and the cursor exactly
 * where it started. Nothing was skipped there: the next read asks for the same batch again. The
 * gap is stamped only once the cursor has moved or bytes have been counted, which is the case
 * where output really did go past this record and will not be offered again.
 *
 * **An abandoned read is not a gap, and calls no `noteGap`.** The cursor it returns is exactly the
 * last event the mirror appended, so the next read resumes from there: nothing is duplicated and
 * nothing is lost — the bytes were simply not fetched yet. That is the difference from the throw
 * path, where the cursor moved past output this record will never see.
 *
 * `scan` is the third consumer of the same bytes and the newest (#376): the attempt loop's read of
 * the turn's own `result` message. It is handed each stdout chunk exactly once, in order, for the
 * same reason the mirror is — these reads are where the turn's output is, and nothing else in the
 * driver sees it.
 */
export async function readLogSample(
  process: SandboxProcessHandle,
  previous: LogSample,
  mirror?: LiveMirror,
  timeoutMs: number = LOG_READ_TIMEOUT_MS,
  scan?: (chunk: Uint8Array) => void,
): Promise<LogSample> {
  const stop = new AbortController()
  const progress: ReadProgress = { cursor: previous.cursor, bytes: 0, stop }
  const { expiry, cancel } = readDeadline(timeoutMs, stop)
  try {
    // The timer is cleared in the `finally` whichever side wins, so a read that finishes first
    // leaves nothing pending — the same rule `sampleTick` follows in the watchdog loop.
    //
    // A drain that fails *after* it was abandoned is deliberately not a gap: `Promise.race`
    // observes the rejection (so nothing is unhandled), and no byte past the returned cursor was
    // appended or counted, so the next read resumes from the exact same place and the record
    // has lost nothing. Stamping it `truncated` for that would be admitting a loss that did not
    // happen.
    await Promise.race([drainLogBatch(process, previous.cursor, progress, mirror, scan), expiry])
    if (stop.signal.aborted) {
      console.warn(`watchdog log read abandoned process_id=${process.id} after_ms=${timeoutMs}`)
    }
  }
  catch (cause) {
    console.warn(`watchdog log read failed process_id=${process.id} error="${describeCause(cause)}"`)
    if (progress.bytes > 0 || progress.cursor !== previous.cursor) {
      mirror?.noteGap()
    }
  }
  finally {
    cancel()
  }
  return { cursor: progress.cursor, bytes: progress.bytes }
}

/**
 * The abandonment timer.
 *
 * It resolves rather than rejects, because a read that ran out of time is not a failure to report
 * — it is a partial answer to return. Aborting `stop` before resolving does two things: the
 * still-running iteration stops appending to a mirror whose snapshot has already moved on, and
 * the backend is told to end the read it was asked for (`ProcessLogsOptions.signal`), so the
 * drain settles instead of sitting on a stream that may never deliver another event — which is
 * what would otherwise leave one pending reader behind per abandoned tick for the rest of a turn.
 */
function readDeadline(timeoutMs: number, stop: AbortController): { expiry: Promise<void>, cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      stop.abort()
      resolve()
    }, timeoutMs)
  })
  return { expiry, cancel: () => clearTimeout(timer) }
}

/**
 * Take the batch event by event into `progress`, stopping at the first event seen after the read
 * was abandoned — returning there is what lets `iterateStream` cancel the stream's reader. The
 * abort signal goes to the backend too, so a stream with no next event to stop at is ended from
 * its side.
 */
async function drainLogBatch(
  process: SandboxProcessHandle,
  since: string | undefined,
  progress: ReadProgress,
  mirror?: LiveMirror,
  scan?: (chunk: Uint8Array) => void,
): Promise<void> {
  const { signal } = progress.stop
  const stream = await process.logs({ since, replay: true, follow: false, signal })
  for await (const event of iterateStream(stream)) {
    if (signal.aborted) {
      return
    }
    progress.cursor = event.cursor ?? progress.cursor
    if (event.type === 'stdout' || event.type === 'stderr') {
      progress.bytes += event.data.byteLength
      if (event.type === 'stdout') {
        mirror?.append(event.data, event.cursor)
        scan?.(event.data)
      }
    }
  }
}
