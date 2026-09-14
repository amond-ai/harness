/**
 * The three shapes `logs()` answers in, and the reads behind them.
 *
 * Split out of `vercel-session.ts` for the reason its e2b and Daytona siblings were: the whole of
 * `logs()` is one responsibility (journal bytes → a `ReadableStream` of events) with one
 * dependency on the rest of the session, the journal reader it is handed.
 *
 * The three reads are not variations on one another; each exists for a different caller:
 *
 * | Read | Caller | Ends when |
 * | --- | --- | --- |
 * | whole transcript | `replayTurn`, after the turn | the journal's current end |
 * | positioned (`since`) | the liveness watchdog, per sample | the slice is served |
 * | following (`follow`) | `@amond-ai/harness-sandbox`, live | the process exits or the caller aborts |
 *
 * **No read ever emits `{ type: 'truncated' }`.** The contract has the event for a backend whose
 * retained log is a bounded buffer — Cloudflare's is — and a reader that never sees one is
 * entitled to conclude it has the whole transcript. Here it never sees one because there is
 * nothing to lose: the journal is two ordinary files in the sandbox's own filesystem, written by
 * the wrapper of `journal.ts` and read by byte offset, with nothing rotating, evicting or
 * capping them for the sandbox's life. The absence is a fact about this backend, not an
 * unimplemented case, which is why it is written down rather than left to be inferred from a
 * `grep` that finds no emitter.
 */
import type { ProcessExit, ProcessLogEvent, ProcessLogsOptions } from '@amond-ai/sandbox'
import type { JournalPaths } from './journal'
import type { JournalTail } from './log-follow'
import type { JournalSlice } from './log-replay'
import type { ProbeReading } from './vercel-probe'
import { followJournal } from './log-follow'
import { decodeCursor, encodeCursor, replayPositioned } from './log-replay'

/**
 * Bytes per emitted event.
 *
 * Vercel's `readFileToBuffer` hands back the whole file, so this buys no memory the read has not
 * already spent — what it buys is the *shape* the consumers were written against: `replayTurn`
 * folds a turn into a bounded window "so the full transcript never exists in memory" (AC-016) and
 * `processStderr` drains stdout to keep only stderr's bounded tail. One event carrying a noisy
 * turn's entire output defeats neither's correctness but does defeat their back-pressure.
 */
const CHUNK_BYTES = 65_536

export interface LogReadSources {
  paths: JournalPaths
  /** How the process ended, or `undefined` while it is still running. */
  readExit: () => Promise<ProcessExit | undefined>
  readSliceFrom: (path: string, offset: number) => Promise<JournalSlice>
  /** A whole journal file, or `undefined` when it is not there. */
  readWhole: (path: string) => Promise<Uint8Array | undefined>
  /** One liveness-plus-lengths reading. See {@link JournalTail.probe}. Follow reads only. */
  probe: () => Promise<ProbeReading>
  now: () => string
  /** Passed through to {@link followJournal}; see `VercelSessionOptions.followIntervalMs`. */
  followIntervalMs: number
}

/** One stream's bytes, cut into events rather than emitted whole. */
function* chunked(bytes: Uint8Array | undefined): Generator<Uint8Array> {
  const all = bytes ?? new Uint8Array(0)
  for (let at = 0; at < all.length; at += CHUNK_BYTES) {
    yield all.subarray(at, Math.min(at + CHUNK_BYTES, all.length))
  }
}

/**
 * A generator served one event per `pull`, rather than buffered into the stream up front.
 *
 * `beforeReturn` runs *before* the generator is returned to, because a tail cannot be stopped by
 * `return()` alone: a `ReadableStream` keeps one `pull` in flight to refill its queue, so at
 * cancel time the generator is usually inside `next()` — sleeping out a poll interval against a
 * process that may never exit — and the `return()` queues behind it. That deadlocks the canceller
 * (measured on the e2b sibling, 2026-08-27: `reader.cancel()` never settled). Aborting first ends
 * the poll, and only then is the return awaited. The follow read passes its abort here for that
 * reason; see {@link createProcessLogs}.
 */
function pulledStream(
  events: AsyncGenerator<ProcessLogEvent>,
  beforeReturn?: () => void,
): ReadableStream<ProcessLogEvent> {
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await events.next()
      if (done === true) {
        controller.close()
        return
      }
      controller.enqueue(value)
    },
    async cancel(reason) {
      beforeReturn?.()
      await events.return(reason)
    },
  })
}

export function createProcessLogs(
  sources: LogReadSources,
): (options?: ProcessLogsOptions) => Promise<ReadableStream<ProcessLogEvent>> {
  const { now, paths, readExit, readSliceFrom, readWhole } = sources

  /**
   * `replayTurn`'s read: the transcript entire, and how the turn ended.
   *
   * The ending is read first so the terminal event's exit code cannot depend on what the
   * transcript did to the clock. Only an `exited` ending is emitted, matching both siblings: a
   * whole-transcript read of a process that vanished has already said so through `status()`, and
   * a terminal error appended to a replay would be a second, later-timestamped account of the
   * same failure.
   *
   * stdout runs to completion before stderr starts, because `demuxProcessEvents` splits on the
   * event tag and reassembles each stream in the order its chunks arrive.
   */
  async function* wholeTranscript(): AsyncGenerator<ProcessLogEvent> {
    const exit = await readExit()
    let stdout = 0
    for (const chunk of chunked(await readWhole(paths.out))) {
      stdout += chunk.length
      yield { type: 'stdout', cursor: encodeCursor(stdout, 0), timestamp: now(), data: chunk }
    }
    let stderr = 0
    for (const chunk of chunked(await readWhole(paths.err))) {
      stderr += chunk.length
      yield { type: 'stderr', cursor: encodeCursor(stdout, stderr), timestamp: now(), data: chunk }
    }
    if (exit !== undefined) {
      yield {
        type: 'terminal',
        state: 'exited',
        cursor: encodeCursor(stdout, stderr),
        timestamp: now(),
        exit,
      }
    }
  }

  /** The watchdog's read: what arrived since last time, and nothing before it. */
  async function incrementSince(since: string): Promise<readonly ProcessLogEvent[]> {
    const from = decodeCursor(since)
    const [stdout, stderr] = await Promise.all([
      readSliceFrom(paths.out, from.stdout),
      readSliceFrom(paths.err, from.stderr),
    ])
    return replayPositioned({ stdout, stderr }, now())
  }

  /**
   * The live read, and the one that needs a stop signal of its own.
   *
   * `cancel()` cannot simply `return()` the generator — see {@link pulledStream} for the measured
   * deadlock. Aborting first ends the poll, and only then is the return awaited.
   *
   * The caller's listener is dropped once the tail is done, in a `finally` rather than at the
   * cancel site: a follow that ends on its own — the process exited — never reaches `cancel`, and
   * the one signal `harness-sandbox` passes here outlives the process it was spawned for, so a
   * listener left behind per `logs()` call accumulates on it for the session's lifetime.
   */
  function followingStream(options: ProcessLogsOptions): ReadableStream<ProcessLogEvent> {
    const stop = new AbortController()
    const caller = options.signal
    const onAbort = (): void => stop.abort()
    if (caller?.aborted === true) {
      stop.abort()
    }
    else {
      caller?.addEventListener('abort', onAbort, { once: true })
    }
    const tail: JournalTail = {
      readSliceFrom,
      probe: sources.probe,
      readExit,
      now,
      intervalMs: sources.followIntervalMs,
      paths: { stdout: paths.out, stderr: paths.err },
    }
    // Positioned or not, a follower resumes from wherever it was told to and then stays open;
    // `terminal` is what the two reads still disagree about (see `FollowOptions`).
    async function* followed(): AsyncGenerator<ProcessLogEvent> {
      try {
        yield* followJournal(tail, {
          // A cursor when the caller has one; otherwise `replay` decides, because that is the
          // word the contract gives the difference — retained log from the beginning, or the live
          // tail. `harness-sandbox` passes `replay: true` for exactly this reason.
          from: options.since !== undefined
            ? decodeCursor(options.since)
            : options.replay === true ? { stdout: 0, stderr: 0 } : 'tail',
          terminal: options.since === undefined,
          signal: stop.signal,
        })
      }
      finally {
        caller?.removeEventListener('abort', onAbort)
      }
    }
    return pulledStream(followed(), () => stop.abort())
  }

  return async (logOptions) => {
    if (logOptions?.follow === true) {
      return followingStream(logOptions)
    }
    if (logOptions?.since !== undefined) {
      const events = await incrementSince(logOptions.since)
      return new ReadableStream({
        start(controller) {
          for (const event of events) {
            controller.enqueue(event)
          }
          controller.close()
        },
      })
    }
    // Pulled rather than pushed: enqueuing eagerly would buffer the transcript inside the stream
    // on top of the copy the read already holds.
    return pulledStream(wholeTranscript())
  }
}
