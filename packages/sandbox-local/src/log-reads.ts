/**
 * The three shapes `logs()` answers in, and the reads behind them.
 *
 * They are not variations on one another; each exists for a different caller:
 *
 * | Read | Caller | Ends when |
 * | --- | --- | --- |
 * | whole transcript | a replay after the turn | the journal's current end |
 * | positioned (`since`) | the liveness watchdog, per sample | the slice is served |
 * | following (`follow`) | `@amond-ai/harness-sandbox`, live | the process is gone, or the caller aborts |
 *
 * The follow read ends on the *process*, never on the journal: a file that has stopped growing
 * is a command thinking, and a reader that took quiet for finished would cut a turn off
 * mid-thought.
 */
import type { ProcessLogEvent, ProcessLogsOptions } from '@amond-ai/sandbox'
import type { JournalPaths } from './journal'
import type { JournalIo } from './journal-io'
import { decodeCursor, encodeCursor, replayPositioned } from './log-replay'

export interface LogReadSources {
  paths: JournalPaths
  io: JournalIo
  /**
   * Whether the process and everything it left behind are gone.
   *
   * The session's verdict rather than a re-derivation, and deliberately not "the exit file
   * exists": that file is written by the command's own shell, on a filesystem the command can
   * write to, and a follow that ended on it would stop reading a turn that had merely claimed
   * to be over.
   */
  isGone: () => Promise<boolean>
  now: () => string
  /** How long a follower waits after a read that found nothing new. */
  followIntervalMs: number
}

/**
 * A generator served one event per `pull`, rather than buffered into the stream up front.
 *
 * `beforeReturn` runs *before* the generator is returned to, because a tail cannot be stopped
 * by `return()` alone: a `ReadableStream` keeps one `pull` in flight to refill its queue, so at
 * cancel time the generator is usually inside `next()` and the `return()` queues behind it.
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

/** Sleep, or wake early when the caller gives up. */
async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return
  }
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export function createProcessLogs(
  sources: LogReadSources,
): (options?: ProcessLogsOptions) => Promise<ReadableStream<ProcessLogEvent>> {
  const { io, isGone, now, paths } = sources

  /**
   * The whole transcript, and how the process ended.
   *
   * Emitted chunk by chunk rather than as one event per stream: callers fold the transcript
   * into a bounded window precisely so the whole of it never exists in memory at once, and
   * handing them a single `Uint8Array` per stream would defeat the guarantee they were written
   * against. The exit is read first, before the transcript can move the clock.
   */
  async function* wholeTranscript(): AsyncGenerator<ProcessLogEvent> {
    const exit = await io.readExit(paths)
    let stdout = 0
    for await (const chunk of io.streamFile(paths.stdout)) {
      stdout += chunk.length
      yield { type: 'stdout', cursor: encodeCursor(stdout, 0), timestamp: now(), data: chunk }
    }
    let stderr = 0
    for await (const chunk of io.streamFile(paths.stderr)) {
      stderr += chunk.length
      yield { type: 'stderr', cursor: encodeCursor(stdout, stderr), timestamp: now(), data: chunk }
    }
    if (exit) {
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
      io.readSliceFrom(paths.stdout, from.stdout),
      io.readSliceFrom(paths.stderr, from.stderr),
    ])
    return replayPositioned({ stdout, stderr }, now())
  }

  /**
   * The live read.
   *
   * One read always follows the `isGone` verdict before the stream closes. The verdict and the
   * last write race — a command's final line lands between the read that found nothing and the
   * probe that found it dead — so ending on the verdict itself would drop exactly the bytes a
   * caller cares most about, the ones that say how the turn finished.
   */
  async function* followed(
    from: { stdout: number, stderr: number } | 'tail',
    terminal: boolean,
    signal: AbortSignal,
  ): AsyncGenerator<ProcessLogEvent> {
    let cursor = from === 'tail'
      ? {
          stdout: await io.readEndOffset(paths.stdout),
          stderr: await io.readEndOffset(paths.stderr),
        }
      : from
    let goneSeen = false
    while (!signal.aborted) {
      const [stdout, stderr] = await Promise.all([
        io.readSliceFrom(paths.stdout, cursor.stdout),
        io.readSliceFrom(paths.stderr, cursor.stderr),
      ])
      cursor = { stdout: stdout.total, stderr: stderr.total }
      for (const event of replayPositioned({ stdout, stderr }, now())) {
        yield event
      }
      if (stdout.data.length > 0 || stderr.data.length > 0) {
        // Still draining. Read again straight away rather than sleeping on a live stream.
        continue
      }
      if (goneSeen) {
        const exit = terminal ? await io.readExit(paths) : undefined
        if (exit) {
          yield {
            type: 'terminal',
            state: 'exited',
            cursor: encodeCursor(cursor.stdout, cursor.stderr),
            timestamp: now(),
            exit,
          }
        }
        return
      }
      goneSeen = await isGone()
      if (!goneSeen) {
        await delay(sources.followIntervalMs, signal)
      }
    }
  }

  /**
   * The follow read's own stop signal.
   *
   * `cancel()` cannot simply `return()` the generator: a `ReadableStream` keeps one `pull` in
   * flight, so at cancel time the tail is usually inside `next()` — waiting on a process that
   * may never exit — and the `return()` queues behind it, which deadlocks the canceller.
   * Aborting first ends the wait, and only then is the return awaited.
   *
   * The caller's listener is dropped in a `finally` rather than at the cancel site: a follow
   * that ends on its own never reaches `cancel`, and the signal a caller passes here outlives
   * the process it was spawned for, so a listener left behind per `logs()` call would
   * accumulate on it for the session's lifetime.
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
    async function* following(): AsyncGenerator<ProcessLogEvent> {
      try {
        // A cursor when the caller has one; otherwise `replay` decides, because that is the
        // word the contract gives the difference — the retained log from the beginning, or the
        // live tail.
        yield* followed(
          options.since !== undefined
            ? decodeCursor(options.since)
            : options.replay === true ? { stdout: 0, stderr: 0 } : 'tail',
          options.since === undefined,
          stop.signal,
        )
      }
      finally {
        caller?.removeEventListener('abort', onAbort)
      }
    }
    return pulledStream(following(), () => stop.abort())
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
