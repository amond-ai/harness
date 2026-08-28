/**
 * The three shapes `logs()` answers in, and the reads behind them.
 *
 * Split out of `e2b-session.ts` for the reason the lifetime renewer was: that file sits at
 * the repository's 500-LOC limit, and adding the follow read to it put it 59 lines over.
 * This is the cut that costs least — the whole of `logs()` is one responsibility (journal
 * bytes → a `ReadableStream` of events) with one dependency on the rest of the session, the
 * journal reader it is handed.
 *
 * The three reads are not variations on one another; each exists for a different caller:
 *
 * | Read | Caller | Ends when |
 * | --- | --- | --- |
 * | whole transcript | `replayTurn`, after the turn | the journal's current EOF |
 * | positioned (`since`) | the liveness watchdog, per sample | the slice is served |
 * | following (`follow`) | `@pleaseai/harness-sandbox`, live | the process exits or the caller aborts |
 */
import type { ProcessLogEvent, ProcessLogsOptions } from '@pleaseai/sandbox-contract'
import type { JournalPaths } from './journal'
import type { PartialRead } from './journal-io'
import type { JournalTail } from './log-follow'
import type { JournalSlice } from './log-replay'
import { followJournal } from './log-follow'
import { decodeCursor, encodeCursor, replayPositioned } from './log-replay'

export interface LogReadSources {
  paths: JournalPaths
  readExitCode: () => Promise<number | undefined>
  readSliceFrom: (path: string, offset: number) => Promise<JournalSlice>
  /** Where a file ends, for a follower starting at the live tail. See {@link JournalTail.readEndOffset}. */
  readEndOffset: (path: string) => Promise<number>
  streamFile: (path: string, partial?: PartialRead) => AsyncGenerator<Uint8Array>
  /** The session's liveness verdict — see {@link JournalTail.isGone}. Follow reads only. */
  isGone: () => Promise<boolean>
  now: () => string
  /** Monotonic milliseconds, for rate-limiting the liveness probe. Follow reads only. */
  elapsedMs: () => number
  /** Passed through to {@link followJournal}; see `E2bSessionOptions.followIntervalMs`. */
  followIntervalMs: number
  /** The shortest gap between two liveness probes. See {@link JournalTail.livenessIntervalMs}. */
  livenessIntervalMs: number
}

/**
 * A generator served one event per `pull`, rather than buffered into the stream up front.
 *
 * `beforeReturn` runs *before* the generator is returned to, because a tail cannot be stopped
 * by `return()` alone: a `ReadableStream` keeps one `pull` in flight to refill its queue, so at
 * cancel time the generator is usually inside `next()` and the `return()` queues behind it. The
 * follow read passes its abort here for that reason; see {@link createProcessLogs}.
 */
function pulledStream(
  events: AsyncGenerator<ProcessLogEvent>,
  beforeReturn?: () => void,
): ReadableStream<ProcessLogEvent> {
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await events.next()
      if (done) {
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
  const { paths, readExitCode, readSliceFrom, streamFile, now } = sources

  /**
   * `replayTurn`'s read: the transcript entire, and how the turn ended.
   *
   * Emitted chunk by chunk rather than as one event per stream. `replayTurn` folds into a
   * bounded window precisely "so the full transcript never exists in memory (AC-016)",
   * and `processStderr` drains stdout to keep only stderr's bounded tail — both written
   * against a stream. Handing them one `Uint8Array` per stream defeats the guarantee they
   * were built on and puts a noisy turn's whole transcript in a 128MB isolate (codex
   * review, PR #260).
   *
   * stdout runs to completion before stderr starts, because `demuxProcessEvents` splits
   * on the event tag and the exit record is read first — it is four bytes, and reading it
   * up front keeps the terminal event's exit code from depending on what the transcript
   * did to the clock.
   */
  async function* wholeTranscript(): AsyncGenerator<ProcessLogEvent> {
    const exitCode = await readExitCode()
    let stdout = 0
    for await (const chunk of streamFile(paths.stdout, 'fail')) {
      stdout += chunk.length
      yield { type: 'stdout', cursor: encodeCursor(stdout, 0), timestamp: now(), data: chunk }
    }
    let stderr = 0
    for await (const chunk of streamFile(paths.stderr, 'fail')) {
      stderr += chunk.length
      yield { type: 'stderr', cursor: encodeCursor(stdout, stderr), timestamp: now(), data: chunk }
    }
    if (exitCode !== undefined) {
      yield {
        type: 'terminal',
        state: 'exited',
        cursor: encodeCursor(stdout, stderr),
        timestamp: now(),
        exit: { code: exitCode, timedOut: false },
      }
    }
  }

  /** The watchdog's read: what arrived since last time, and nothing before it. */
  async function incrementSince(since: string): Promise<readonly ProcessLogEvent[]> {
    const from = decodeCursor(since)
    const [stdout, stderr] = await Promise.all([
      readSliceFrom(paths.stdout, from.stdout),
      readSliceFrom(paths.stderr, from.stderr),
    ])
    return replayPositioned({ stdout, stderr }, now())
  }

  /**
   * The live read, and the one that needs a stop signal of its own.
   *
   * `cancel()` cannot simply `return()` the generator: a `ReadableStream` keeps one `pull` in
   * flight to refill its queue, so at cancel time the tail is usually *inside* `next()` —
   * polling a process that may never exit — and `return()` queues behind it. That deadlocks
   * the canceller (measured 2026-08-27: `reader.cancel()` never settled). Aborting first ends
   * the poll, and only then is the return awaited — which is what {@link pulledStream}'s
   * `beforeReturn` hook is for.
   *
   * The caller's listener is dropped once the tail is done, in a `finally` rather than at the
   * cancel site: a follow that ends on its own — the process exited — never reaches `cancel`,
   * and the one signal `harness-sandbox` passes here outlives the process it was spawned for,
   * so a listener left behind per `logs()` call accumulates on it for the session's lifetime.
   */
  function followingStream(options: ProcessLogsOptions): ReadableStream<ProcessLogEvent> {
    const stop = new AbortController()
    const caller = options.signal
    const onAbort = () => stop.abort()
    if (caller?.aborted === true) {
      stop.abort()
    }
    else {
      caller?.addEventListener('abort', onAbort, { once: true })
    }
    // Positioned or not, a follower resumes from wherever it was told to and then stays open;
    // `terminal` is what the two reads still disagree about (see `FollowOptions`).
    async function* followed(): AsyncGenerator<ProcessLogEvent> {
      try {
        yield* followJournal({
          readSliceFrom,
          readEndOffset: sources.readEndOffset,
          readExitCode,
          isGone: sources.isGone,
          now,
          elapsedMs: sources.elapsedMs,
          intervalMs: sources.followIntervalMs,
          livenessIntervalMs: sources.livenessIntervalMs,
          paths,
        }, {
          // A cursor when the caller has one; otherwise `replay` decides, because that is the
          // word the contract gives the difference — retained log from the beginning, or the
          // live tail. `harness-sandbox` passes `replay: true` for exactly this reason.
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
    // Pulled rather than pushed: enqueuing eagerly would buffer the transcript inside the
    // stream, which is the thing being avoided.
    return pulledStream(wholeTranscript())
  }
}
