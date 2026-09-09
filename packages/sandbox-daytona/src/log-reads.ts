/**
 * The three shapes `logs()` answers in, and the reads behind them.
 *
 * Split out of `daytona-session.ts` for the reason its e2b sibling was: the whole of `logs()` is
 * one responsibility (a command's retained output → a `ReadableStream` of events) with one
 * dependency on the rest of the session, the reader it is handed.
 *
 * The three reads are not variations on one another; each exists for a different caller:
 *
 * | Read | Caller | Ends when |
 * | --- | --- | --- |
 * | whole transcript | `replayTurn`, after the turn | the log's current end |
 * | positioned (`since`) | the liveness watchdog, per sample | the slice is served |
 * | following (`follow`) | `@amond-ai/harness-sandbox`, live | the process ends or the caller aborts |
 *
 * All three go through the *buffered* `getSessionCommandLogs`, never its streaming overload. That
 * overload opens a WebSocket to the toolbox daemon and demultiplexes stdout from stderr with an
 * in-band byte prefix (research note 035 §3); the buffered one is plain HTTP and hands back the
 * two streams already separated. A follow therefore polls, and pays one full transfer of the
 * command's output per interval — Daytona has no byte-range read, the same trade the e2b backend
 * makes for the same reason.
 */
import type { ProcessExit, ProcessFailure, ProcessLogEvent, ProcessLogsOptions } from '@amond-ai/sandbox'
import type { DaytonaSessionLogs } from './daytona-surface'
import { decodeCursor, encodeCursor, replayPositioned, sliceFrom } from './log-replay'

/** How a process ended, as the session decides it. `undefined` while it is still running. */
export type ProcessEnding
  = | { state: 'exited', exit: ProcessExit }
    | { state: 'error', error: ProcessFailure }

/**
 * Bytes per emitted event.
 *
 * Daytona hands back the whole log as one string, so this buys no memory the read has not
 * already spent — what it buys is the *shape* the consumers were written against: `replayTurn`
 * folds a turn into a bounded window "so the full transcript never exists in memory" (AC-016)
 * and `processStderr` drains stdout to keep only stderr's bounded tail. One event carrying a
 * noisy turn's entire output defeats neither's correctness but does defeat their back-pressure.
 */
const CHUNK_BYTES = 65_536

export interface LogReadSources {
  readLogs: () => Promise<DaytonaSessionLogs>
  ending: () => Promise<ProcessEnding | undefined>
  now: () => string
  /** How long a following read waits between polls. */
  followIntervalMs: number
}

/** One stream's bytes, cut into events rather than emitted whole. */
function* chunked(text: string | undefined): Generator<Uint8Array> {
  const bytes = new TextEncoder().encode(text ?? '')
  for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
    yield bytes.subarray(at, Math.min(at + CHUNK_BYTES, bytes.length))
  }
}

/**
 * A generator served one event per `pull`, rather than buffered into the stream up front.
 *
 * `beforeReturn` runs *before* the generator is returned to, because a tail cannot be stopped by
 * `return()` alone: a `ReadableStream` keeps one `pull` in flight to refill its queue, so at
 * cancel time the generator is usually inside `next()` — sleeping out a poll interval against a
 * process that may never exit — and the `return()` queues behind it. Aborting first ends the
 * poll, and only then is the return awaited.
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

/** Resolve after `ms`, or as soon as `signal` aborts — whichever comes first. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  // An abort that lands *during* a poll has already fired by the time this is reached, and a
  // listener added to a fired signal is never called — so without this the tail would wait out
  // the whole interval after its reader has gone.
  if (signal?.aborted === true) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function terminalEvent(ending: ProcessEnding, cursor: string, at: string): ProcessLogEvent {
  return ending.state === 'exited'
    ? { type: 'terminal', state: 'exited', cursor, timestamp: at, exit: ending.exit }
    : { type: 'terminal', state: 'error', cursor, timestamp: at, error: ending.error }
}

export function createProcessLogs(
  sources: LogReadSources,
): (options?: ProcessLogsOptions) => Promise<ReadableStream<ProcessLogEvent>> {
  const { ending, now, readLogs } = sources

  /**
   * `replayTurn`'s read: the transcript entire, and how the turn ended.
   *
   * The ending is read first so the terminal event's exit code cannot depend on what the
   * transcript did to the clock. Only an `exited` ending is emitted here, matching the e2b
   * backend: a whole-transcript read of a process that vanished has already said so through
   * `status()`, and a terminal error appended to a replay would be a second, later-timestamped
   * account of the same failure.
   */
  async function* wholeTranscript(): AsyncGenerator<ProcessLogEvent> {
    const ended = await ending()
    const logs = await readLogs()
    let stdout = 0
    for (const chunk of chunked(logs.stdout)) {
      stdout += chunk.length
      yield { type: 'stdout', cursor: encodeCursor(stdout, 0), timestamp: now(), data: chunk }
    }
    let stderr = 0
    for (const chunk of chunked(logs.stderr)) {
      stderr += chunk.length
      yield { type: 'stderr', cursor: encodeCursor(stdout, stderr), timestamp: now(), data: chunk }
    }
    if (ended?.state === 'exited') {
      yield terminalEvent(ended, encodeCursor(stdout, stderr), now())
    }
  }

  /** The watchdog's read: what arrived since last time, and nothing before it. */
  async function positioned(since: string): Promise<readonly ProcessLogEvent[]> {
    const from = decodeCursor(since)
    const logs = await readLogs()
    return replayPositioned({
      stdout: sliceFrom(logs.stdout, from.stdout),
      stderr: sliceFrom(logs.stderr, from.stderr),
    }, now())
  }

  /**
   * The live read: everything from `from` onwards, and everything the command gains until it
   * ends or the caller aborts.
   *
   * `harness-sandbox` reads end-of-stream as "the bridge exited", so this may not close while the
   * process is alive — and it must close once it is not, whether the command exited or its
   * session vanished. Either ending buys one final poll first: bytes flushed between the last
   * poll and the verdict would otherwise be lost.
   */
  async function* followed(options: ProcessLogsOptions, signal: AbortSignal): AsyncGenerator<ProcessLogEvent> {
    const first = await readLogs()
    const at = options.since !== undefined
      ? decodeCursor(options.since)
      // `replay` is the contract's own word for the difference — the retained log from the
      // beginning, or the live tail — and a follower that ignored it would serve a late
      // subscriber the whole transcript it deliberately did not ask for.
      : options.replay === true
        ? { stdout: 0, stderr: 0 }
        : { stdout: sliceFrom(first.stdout, 0).total, stderr: sliceFrom(first.stderr, 0).total }

    async function* drain(logs: DaytonaSessionLogs): AsyncGenerator<ProcessLogEvent> {
      const stdout = sliceFrom(logs.stdout, at.stdout)
      const stderr = sliceFrom(logs.stderr, at.stderr)
      at.stdout = stdout.total
      at.stderr = stderr.total
      yield* replayPositioned({ stdout, stderr }, now())
    }

    let logs = first
    for (;;) {
      if (signal.aborted) {
        return
      }
      yield* drain(logs)
      const ended = await ending()
      if (ended) {
        yield* drain(await readLogs())
        // No terminal for a positioned follow, for the reason `log-replay.ts` gives: a caller
        // resuming from a cursor is sampling, and re-serving the exit would double-count it. The
        // stream still closes, which is what a follower reads.
        if (options.since === undefined) {
          yield terminalEvent(ended, encodeCursor(at.stdout, at.stderr), now())
        }
        return
      }
      await sleep(sources.followIntervalMs, signal)
      logs = await readLogs()
    }
  }

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
    async function* guarded(): AsyncGenerator<ProcessLogEvent> {
      try {
        yield* followed(options, stop.signal)
      }
      finally {
        // Dropped in a `finally` rather than at the cancel site: a follow that ends on its own
        // never reaches `cancel`, and the signal `harness-sandbox` passes outlives the process it
        // was spawned for — a listener left behind per `logs()` call accumulates on it.
        caller?.removeEventListener('abort', onAbort)
      }
    }
    return pulledStream(guarded(), () => stop.abort())
  }

  return async (logOptions) => {
    if (logOptions?.follow === true) {
      return followingStream(logOptions)
    }
    if (logOptions?.since !== undefined) {
      const events = await positioned(logOptions.since)
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
