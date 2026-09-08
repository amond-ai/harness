/**
 * The journal, tailed — what `logs({ follow: true })` answers with.
 *
 * Separate from `log-replay.ts`, which projects a *snapshot* into events, and from
 * `e2b-session.ts`, which is at the repository's 500-LOC limit. The split is also the honest
 * one: replay is pure and takes bytes it is handed, while a tail owns a clock and a stopping
 * rule, which is the entire difficulty here.
 *
 * **Why a tail is needed at all.** The Cloudflare backend's `logs()` follows natively, and
 * this one answered `follow` with a snapshot until 2026-08-27 — invisible to the orchestrator,
 * which reads a turn's transcript *after* it exits, where a snapshot and a tail cannot be told
 * apart. `@amond-ai/harness-sandbox` opens `{ follow: true, replay: true }` on the AI SDK
 * bridge and the harness reads that stream as a liveness channel: `waitForBridgeReady` takes
 * end-of-stream as `bridge exited before becoming ready`. Measured with
 * `scripts/spike-e2b-follow.ts` — the stream closed at 1489ms against a process that ran to
 * 16680ms, so a healthy bridge was reported dead whenever the EOF beat the readiness signal.
 *
 * **The stopping rule is e2b's process table, not the journal — the same rule `statusOf` and
 * `waitForExit` already keep.** The exit file is writable by the turn, so a prompt-injected or
 * merely buggy process can journal an exit for itself while it is still writing; the process
 * table is the part it cannot forge. A tail that believed the file alone would close a live
 * stream mid-transcript, and the harness reads a closed stream as the bridge dying. So an exit
 * record only *forces a probe*, and the loop ends when the probe agrees the process is gone.
 *
 * The other half of that rule matters more here than in a wait. The wrapper writes
 * `printf '%s' "$?"` **after** the command, so a killed or OOM-reaped wrapper never writes one
 * at all — `kill()` takes the whole session down. A tail with no escape would then follow a
 * process that no longer exists for as long as its caller lives. Gone with no record is
 * therefore an ending too, reported as the `no_exit_record` terminal the contract already has
 * and `statusOf` already names, rather than as silence (code review, PR #280).
 *
 * Either ending buys one final slice read first: bytes flushed between this loop's last slice
 * read and its verdict would otherwise be lost.
 *
 * **Cost.** e2b has no byte-range read (`e2b-surface.ts`), so each poll transfers the whole
 * journal file and discards what precedes the cursor — the same trade `readSliceFrom` already
 * makes for the watchdog's positioned reads. That is why the tail polls on its own interval
 * rather than the wait loop's `pollIntervalMs`: the caller that needs this is following a
 * bridge's startup banner, not a turn's transcript.
 *
 * It is also why the interval is paid on **every** poll rather than skipped whenever the last
 * one served bytes. Skipping it reads well as a latency choice, but a process that is always
 * mid-write — `pnpm install`, which is on the harness's own bootstrap path — never lets the
 * loop idle, so the tail became a back-to-back full-file download for as long as the output
 * lasted, in a 128MB isolate (code review, PR #280). Paying it bounds the transfer to one file
 * per interval whatever the process does, and costs at most one interval of latency against a
 * bridge-readiness budget of two minutes.
 *
 * The liveness probe is rate-limited separately and more slowly, because it is two remote calls
 * (e2b's table, then `pgrep -s`) rather than a file read — {@link JournalTail.livenessIntervalMs},
 * mirroring what `waitForExit` spends on the same question.
 */
import type { ProcessLogEvent } from '@amond-ai/sandbox'
import type { JournalSlice } from './log-replay'
import { encodeCursor, replayPositioned } from './log-replay'

export interface JournalTail {
  /** Bytes at or after `offset`, plus the file's full length. */
  readSliceFrom: (path: string, offset: number) => Promise<JournalSlice>
  /**
   * Where a file ends, for `from: 'tail'`. Rejects rather than answering `0` for a read
   * that failed — see `readEndOffset` in `journal-io.ts` for why that distinction matters
   * here and nowhere else.
   */
  readEndOffset: (path: string) => Promise<number>
  /** The journalled exit code, or `undefined` while the process is still running. */
  readExitCode: () => Promise<number | undefined>
  /**
   * Whether the process is gone for good, as the session decides it: absent from e2b's table
   * *and* leaving no survivor in its own session. The verdict this loop ends on, because it is
   * the one the turn cannot write.
   */
  isGone: () => Promise<boolean>
  now: () => string
  /** Monotonic milliseconds, for rate-limiting the liveness probe. */
  elapsedMs: () => number
  /** How long to wait between polls. */
  intervalMs: number
  /** The shortest gap between two liveness probes. */
  livenessIntervalMs: number
  paths: { stdout: string, stderr: string }
}

export interface FollowOptions {
  /**
   * Where the stream starts: a cursor, or `'tail'` for the journal's current end.
   *
   * `'tail'` is what a subscriber that did not ask for `replay` gets — the contract calls
   * `replay` "read the retained log from the beginning rather than from the live tail", and
   * a follow that ignored it served a late subscriber the whole transcript it had missed
   * (codex review, PR #280).
   */
  from: { stdout: number, stderr: number } | 'tail'
  /**
   * Whether the stream ends with a terminal event.
   *
   * False for a positioned read, for the reason `log-replay.ts` gives: a caller that resumes
   * from a cursor is sampling, and re-serving the exit on every resumption would double-count
   * it. The stream still *closes* when the process exits, which is what a follower reads.
   */
  terminal: boolean
  signal?: AbortSignal
}

/**
 * Resolve after `ms`, or as soon as `signal` aborts — whichever comes first.
 *
 * The already-aborted case is not a micro-optimisation: an abort that lands *during* a poll
 * has fired before this is reached, and a listener registered on a signal that has already
 * fired is never called — so without the early return the tail waits out the whole interval
 * after its reader has gone (gemini review, PR #280).
 */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Everything the journal holds from `from` onwards, and everything it gains until the process
 * exits or the caller aborts.
 */
export async function* followJournal(
  tail: JournalTail,
  options: FollowOptions,
): AsyncGenerator<ProcessLogEvent> {
  /**
   * The journal's current end, paid for with one full read of each file.
   *
   * e2b has no byte-range read and no length in its listing, so the only way to learn where
   * the tail is, is to read to it — once, at subscribe time, discarding what comes back.
   */
  async function currentEnd(): Promise<{ stdout: number, stderr: number }> {
    const [stdout, stderr] = await Promise.all([
      tail.readEndOffset(tail.paths.stdout),
      tail.readEndOffset(tail.paths.stderr),
    ])
    return { stdout, stderr }
  }

  const at = options.from === 'tail' ? await currentEnd() : { ...options.from }

  async function* drain(): AsyncGenerator<ProcessLogEvent, boolean> {
    const [stdout, stderr] = await Promise.all([
      tail.readSliceFrom(tail.paths.stdout, at.stdout),
      tail.readSliceFrom(tail.paths.stderr, at.stderr),
    ])
    at.stdout = stdout.total
    at.stderr = stderr.total
    const events = replayPositioned({ stdout, stderr }, tail.now())
    yield* events
    return events.length > 0
  }

  /** How the stream ends once {@link JournalTail.isGone} has agreed the process is gone. */
  async function* ending(): AsyncGenerator<ProcessLogEvent> {
    yield* drain()
    const settled = await tail.readExitCode()
    if (!options.terminal) {
      return
    }
    const cursor = encodeCursor(at.stdout, at.stderr)
    yield settled === undefined
      // The wrapper died before recording `$?`. Named exactly as `statusOf` names it, so a
      // caller meets one vocabulary for one condition whichever surface it asked.
      ? {
          type: 'terminal',
          state: 'error',
          cursor,
          timestamp: tail.now(),
          error: {
            code: 'no_exit_record',
            message: 'process is not running and journalled no exit code',
          },
        }
      : {
          type: 'terminal',
          state: 'exited',
          cursor,
          timestamp: tail.now(),
          exit: { code: settled, timedOut: false },
        }
  }

  let nextProbeAt = tail.elapsedMs()
  /** An exit record forces a probe once, so a forged one cannot force one every poll. */
  let claimed = false

  for (;;) {
    if (options.signal?.aborted === true) {
      return
    }
    yield* drain()
    if (await tail.readExitCode() !== undefined && !claimed) {
      claimed = true
      nextProbeAt = tail.elapsedMs()
    }
    if (tail.elapsedMs() >= nextProbeAt) {
      nextProbeAt = tail.elapsedMs() + tail.livenessIntervalMs
      if (await tail.isGone()) {
        yield* ending()
        return
      }
    }
    await sleep(tail.intervalMs, options.signal)
  }
}
