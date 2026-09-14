/**
 * The journal, tailed — what `logs({ follow: true })` answers with.
 *
 * Separate from `log-replay.ts`, which projects a *snapshot* into events, and from
 * `vercel-session.ts`, which is near the repository's 500-LOC limit. The split is also the
 * honest one: replay is pure and takes bytes it is handed, while a tail owns a clock and a
 * stopping rule, which is the entire difficulty here.
 *
 * **Why a tail is needed at all.** `@amond-ai/harness-sandbox` opens `{ follow: true, replay:
 * true }` on the AI SDK bridge and the harness reads that stream as a liveness channel:
 * `waitForBridgeReady` takes end-of-stream as `bridge exited before becoming ready`. A follow
 * answered with a snapshot closes at once and reports a healthy bridge dead — invisible to the
 * orchestrator, which reads a turn's transcript *after* it exits, where a snapshot and a tail
 * cannot be told apart. The e2b backend shipped that bug and measured it (`log-follow.ts:9-16`
 * there): the stream closed at 1489ms against a process that ran to 16680ms.
 *
 * **The stopping rule is the liveness verdict, not the exit file — the same rule `statusOf` and
 * `waitForExit` keep.** `<id>.exit` is written by the turn, so a prompt-injected or merely buggy
 * process can journal an exit for itself while it is still writing; the process group is the
 * part it cannot forge. A tail that believed the file alone would close a live stream
 * mid-transcript, and the harness reads a closed stream as the bridge dying.
 *
 * The other half of that rule matters more here than in a wait. The wrapper writes
 * `printf '%s' "$?"` **after** the command, so a SIGKILLed or OOM-reaped wrapper never writes one
 * at all. A tail with no escape would then follow a process that no longer exists for as long as
 * its caller lives. Gone with no record is therefore an ending too, reported as the
 * `no_exit_record` terminal the contract already has and `statusOf` already names, rather than as
 * silence.
 *
 * Either ending buys one final slice read first: bytes flushed between this loop's last slice
 * read and its verdict would otherwise be lost.
 *
 * **Cost — and the one place this backend is cheaper than its siblings.** Vercel has no
 * byte-range read either (`vercel-surface.ts`), so a drain transfers a whole journal file and
 * discards what precedes the cursor. What the single-command probe of `vercel-probe.ts` buys is
 * that the loop does not have to drain to find out whether there is anything to drain: one
 * `runCommand` answers liveness *and* both file lengths, so a length that has not passed the
 * cursor skips the read entirely. A quiet follow — the bridge's usual state, waiting on a
 * request — therefore transfers zero bytes per poll and costs one command, which is why there is
 * a single {@link JournalTail.intervalMs} here where e2b needs two intervals (it pays a separate,
 * slower rate limit for a liveness question that costs it two more round trips).
 *
 * The interval is paid on **every** poll rather than skipped whenever the last one served bytes.
 * Skipping it reads well as a latency choice, but a process that is always mid-write —
 * `pnpm install`, which is on the harness's own bootstrap path — never lets the loop idle, so the
 * tail becomes a back-to-back full-file download for as long as the output lasts, in a small
 * isolate (code review of the e2b sibling, PR #280). Paying it bounds the transfer to one file
 * per interval whatever the process does, and costs at most one interval of latency against a
 * bridge-readiness budget of two minutes.
 */
import type { ProcessExit, ProcessLogEvent } from '@amond-ai/sandbox'
import type { JournalSlice } from './log-replay'
import type { ProbeReading } from './vercel-probe'
import { encodeCursor, replayPositioned } from './log-replay'

export interface JournalTail {
  /** Bytes at or after `offset`, plus the file's full length. */
  readSliceFrom: (path: string, offset: number) => Promise<JournalSlice>
  /**
   * One reading of liveness, both journal lengths, the timeout marker and the exit record.
   *
   * The loop's only remote call while a process is quiet. See `vercel-probe.ts` for why all five
   * answers come from a single command, and for why `liveness: 'unknown'` is a third state rather
   * than a pessimistic `'gone'`.
   */
  probe: () => Promise<ProbeReading>
  /**
   * How the process ended, read once at the ending.
   *
   * The probe carries an exit code already; this exists for the narrow race where the record
   * lands between the probe's `head -c` and its liveness branch — a wrapper's last two acts are
   * publishing the exit and letting its group empty, in that order, so the ordering that loses
   * the code is the likely one, not the exotic one.
   */
  readExit: () => Promise<ProcessExit | undefined>
  now: () => string
  /** How long to wait between polls. */
  intervalMs: number
  paths: { stdout: string, stderr: string }
}

export interface FollowOptions {
  /**
   * Where the stream starts: a cursor, or `'tail'` for the journal's current end.
   *
   * `'tail'` is what a subscriber that did not ask for `replay` gets — the contract calls
   * `replay` "read the retained log from the beginning rather than from the live tail", and a
   * follow that ignored it served a late subscriber the whole transcript it had missed.
   */
  from: { stdout: number, stderr: number } | 'tail'
  /**
   * Whether the stream ends with a terminal event.
   *
   * False for a positioned read, for the reason `log-replay.ts` gives: a caller that resumes from
   * a cursor is sampling, and re-serving the exit on every resumption would double-count it. The
   * stream still *closes* when the process exits, which is what a follower reads.
   */
  terminal: boolean
  signal?: AbortSignal
}

/**
 * Resolve after `ms`, or as soon as `signal` aborts — whichever comes first.
 *
 * The already-aborted case is not a micro-optimisation: an abort that lands *during* a poll has
 * fired before this is reached, and a listener registered on a signal that has already fired is
 * never called — so without the early return the tail waits out the whole interval after its
 * reader has gone.
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
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Where the journal ends right now, for a `from: 'tail'` subscriber.
 *
 * The probe's length fields, directly — the e2b sibling has to read each file in full and throw
 * the bytes away to learn the same number (`log-follow.ts:144-150` there).
 *
 * Its failure discipline survives the simplification, and is the reason {@link
 * ProbeReading.answered} exists. `-1` from a probe that *answered* means the file is not there
 * yet, which is a real zero. `-1` from a probe that could not run means nothing at all, and
 * answering `0` there would put the tail at the beginning of the journal and replay a whole
 * transcript into a subscriber that asked for none of it. So that case rejects.
 */
async function tailStart(tail: JournalTail): Promise<{ stdout: number, stderr: number }> {
  const reading = await tail.probe()
  if (!reading.answered) {
    throw new Error('cannot start a tail: the journal probe did not answer')
  }
  return { stdout: Math.max(reading.out, 0), stderr: Math.max(reading.err, 0) }
}

/**
 * Everything the journal holds from `from` onwards, and everything it gains until the process
 * exits or the caller aborts.
 */
export async function* followJournal(
  tail: JournalTail,
  options: FollowOptions,
): AsyncGenerator<ProcessLogEvent> {
  const at = options.from === 'tail' ? await tailStart(tail) : { ...options.from }

  async function* drain(): AsyncGenerator<ProcessLogEvent> {
    const [stdout, stderr] = await Promise.all([
      tail.readSliceFrom(tail.paths.stdout, at.stdout),
      tail.readSliceFrom(tail.paths.stderr, at.stderr),
    ])
    at.stdout = stdout.total
    at.stderr = stderr.total
    yield* replayPositioned({ stdout, stderr }, tail.now())
  }

  /** How the stream ends once the probe has agreed the process is gone. */
  async function* ending(reading: ProbeReading): AsyncGenerator<ProcessLogEvent> {
    yield* drain()
    const settled = reading.exitCode === undefined
      ? await tail.readExit()
      : { code: reading.exitCode, timedOut: reading.timedOut }
    if (!options.terminal) {
      return
    }
    const cursor = encodeCursor(at.stdout, at.stderr)
    yield settled === undefined
      // The wrapper died before recording `$?`. Named exactly as `statusOf` names it, so a caller
      // meets one vocabulary for one condition whichever surface it asked.
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
          exit: settled,
        }
  }

  for (;;) {
    if (options.signal?.aborted === true) {
      return
    }
    const reading = await tail.probe()
    // The length fields are the gate. A poll that finds neither file past the cursor transfers
    // nothing — no `readFileToBuffer`, no bytes — which is what makes polling a quiet bridge on a
    // one-second interval affordable. `-1` (no file yet) can never exceed a cursor, so an
    // unstarted or unreadable journal falls through here too.
    if (reading.out > at.stdout || reading.err > at.stderr) {
      yield* drain()
    }
    // `'unknown'` keeps the stream open, exactly as it keeps a wait running: a probe that could
    // not decide is not evidence of death, and closing here tells the harness the bridge died.
    if (reading.liveness === 'gone') {
      yield* ending(reading)
      return
    }
    await sleep(tail.intervalMs, options.signal)
  }
}
