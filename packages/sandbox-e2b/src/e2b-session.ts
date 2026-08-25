/**
 * The e2b backend for {@link SandboxSession}.
 *
 * Where the Cloudflare backend is a naming layer over a client that already has the right
 * semantics, this one supplies semantics e2b does not have. Measured in research note 027:
 * a process vanishes from `commands.list()` when it exits and `commands.connect(pid)` then
 * throws `[not_found]`, so every question the run workflow asks *after* a turn ends — its
 * transcript, its exit code, whether it ran at all — has no e2b answer. The journal is the
 * answer, and this file is the part that decides what it means.
 *
 * The reading itself lives in two modules either side of this one, split along the trust
 * boundary the whole backend turns on: `journal-io.ts` reads what a turn wrote down, and
 * `wrapper-table.ts` reads what e2b still has running. `createE2bProvider` binds the real
 * `Sandbox` to the structural interface in `e2b-surface.ts`.
 */
import type {
  ProcessExit,
  ProcessLogEvent,
  ProcessStatus,
  SandboxCommand,
  SandboxExecOptions,
  SandboxProcessHandle,
  SandboxSession,
} from '@pleaseai/sandbox-contract'
import type { E2bSandboxLike } from './e2b-surface'
import type { JournalMeta } from './journal'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '@pleaseai/sandbox-contract'
import { createE2bFiles } from './e2b-files'
import { isProcessId, journalledCommand, journalPaths, serializeJournalMeta } from './journal'
import { createJournalIo } from './journal-io'
import { decodeCursor, encodeCursor, replayPositioned } from './log-replay'
import { createWrapperTable, livenessFrom } from './wrapper-table'

export type { E2bCommandHandle, E2bFileRead, E2bSandboxLike } from './e2b-surface'

const META_SUFFIX = '.meta.json'
const DEFAULT_POLL_MS = 250

/**
 * How often a wait probes liveness and renews the sandbox's lifetime.
 *
 * Deliberately far coarser than {@link E2bSessionOptions.pollIntervalMs}: reading the exit
 * file is one `files.read`, but liveness is a `commands.list` over the whole process table,
 * and an unbounded wait now runs for the turn's full duration — at 250ms that would be four
 * listings a second for hours against a remote API. The cost of the coarser cadence is a
 * bounded delay in noticing a crashed wrapper (at most one interval), which is paid once
 * per lost process; the per-poll network call would be paid tens of thousands of times per
 * healthy turn.
 */
const LIVENESS_PROBE_INTERVAL_MS = 5_000

/**
 * How many renewals fit inside one sandbox lifetime.
 *
 * Four, so three attempts remain after one fails and the sandbox still outlives the turn,
 * while a long turn pays a handful of `setTimeout` calls rather than one per liveness probe.
 */
const RENEWALS_PER_LIFETIME = 4

/** The shortest gap between two renewals of a `lifetime`-long sandbox. */
function renewalIntervalMs(lifetime: number): number {
  return Math.max(LIVENESS_PROBE_INTERVAL_MS, lifetime / RENEWALS_PER_LIFETIME)
}

export interface E2bSessionOptions {
  /** Directory the journal lives in. Created on first `exec`. */
  journalRoot: string
  newProcessId?: () => string
  now?: () => string
  /** How often `waitForExit` re-reads the exit file. */
  pollIntervalMs?: number
  /**
   * e2b's per-command budget, in milliseconds. `0` — the default here — disables it.
   *
   * Not a stylistic default. e2b's own default is 60s, and it is enforced on *background*
   * commands too: measured with `scripts/spike-e2b-command-timeout.ts`, a background
   * wrapper sleeping 95s left only its first marker under the default and completed under
   * `0`. Every `claude` turn and every repository clone longer than a minute would be
   * killed — and killed in the worst way, since the journal wrapper's trailing
   * `printf '%s' "$?"` never runs, so the turn surfaces as `SandboxNoExitRecordError`
   * rather than as a timeout. The bounds that should apply are the orchestrator's own —
   * the watchdog, the step timeouts, and the sandbox lifetime — none of which this budget
   * knows about (codex review, PR #260).
   */
  commandTimeoutMs?: number
  /**
   * Lifetime re-applied to the sandbox while a wait is in flight. Unset disables renewal.
   *
   * Taken from the provider's configured `timeoutMs` rather than chosen here, so the
   * lifetime that gets renewed is the one the sandbox was created with.
   */
  sandboxTimeoutMs?: number
  /**
   * Monotonic milliseconds. Injected only so a wait's deadline — and the absence of one —
   * can be exercised without spending the wall-clock time it would otherwise take.
   */
  monotonicNowMs?: () => number
}

export function createE2bSession(
  sandbox: E2bSandboxLike,
  options: E2bSessionOptions,
): SandboxSession {
  const newProcessId = options.newProcessId ?? (() => crypto.randomUUID())
  const now = options.now ?? (() => new Date().toISOString())
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS
  const elapsedMs = options.monotonicNowMs ?? (() => Date.now())
  const commandTimeoutMs = options.commandTimeoutMs ?? 0
  // Trailing slashes stripped the way `journalPaths` strips them, so the prefix
  // `journalIdIn` matches against is the one that actually appears in a wrapper's argv.
  const root = options.journalRoot.replace(/\/+$/, '')

  const journal = createJournalIo(sandbox, root)
  const { entries: journalEntries, metaMatching, readExitCode, readListedMeta } = journal
  const { readMeta, readSliceFrom, streamFile } = journal
  const table = createWrapperTable(sandbox, root, now)
  const { killTree, listedWrapper, livenessOf, recoveredCommand, recoveredProcesses } = table

  /**
   * Has this id left anything in the journal — an exit record or a transcript?
   *
   * The last thing that still says a process existed once its meta is unusable and e2b has
   * forgotten it. Absence of both is the only reading that means "no such process here".
   */
  async function journalled(id: string): Promise<boolean> {
    const paths = journalPaths(root, id)
    // A failed probe is not an absence, and it is not swallowed. This answer decides whether
    // `getProcess` returns `null`, which `killTurn` reads as a *confirmed death* — so an e2b
    // blip turned into `false` would clear the way for a second `claude` in the same
    // checkout, the exact hole the rest of this file exists to close (cubic review, PR #260).
    const found = await Promise.all([paths.exit, paths.stdout].map(
      path => sandbox.files.exists(path),
    ))
    return found.includes(true)
  }

  /**
   * The least that can be said about a process known only by its journal files.
   *
   * `command` is required and cannot be recovered — the meta held it and the wrapper is gone
   * from e2b's table — so it is named for what it is rather than guessed at. Nothing reads it
   * in a way that matters: `liveTurnProcess` matches only *live* processes, and a process
   * reached through this path has already exited.
   */
  function withoutMeta(id: string): JournalMeta {
    return { id, pid: 0, command: ['<unrecorded>'], startedAt: now() }
  }

  /** When the lifetime was last pushed back, so a wait does not renew once per probe. */
  let renewedAt: number | undefined

  /**
   * Push the sandbox's stop-clock back while a turn is still running.
   *
   * e2b stops a sandbox at its configured lifetime regardless of what is running inside it,
   * and the run workflow tolerates a live turn for six hours against a lifetime set in
   * minutes. Failure is swallowed because a renewal that did not land is not a reason to
   * abandon a wait over a healthy process — but it is logged, since a silently unrenewed
   * sandbox is the exact failure this call exists to prevent.
   *
   * Rate-limited against the lifetime rather than the caller's cadence: `waitForExit` asks
   * on every liveness probe, and renewing an hourly lifetime every five seconds is ~4,300
   * remote round trips for one turn, all but a handful of them redundant (gemini review,
   * PR #260). The state is per session, not per wait, because the sandbox is one — two
   * concurrent waits renewing it separately would buy nothing.
   */
  async function renewSandboxLifetime(): Promise<void> {
    const lifetime = options.sandboxTimeoutMs
    if (lifetime === undefined) {
      return
    }
    const at = elapsedMs()
    if (renewedAt !== undefined && at - renewedAt < renewalIntervalMs(lifetime)) {
      return
    }
    // Stamped before the call, not after it: an e2b that is refusing `setTimeout` would
    // otherwise be asked again on every probe, which is the cadence this exists to stop.
    // A quarter-lifetime interval still leaves three further attempts before it expires.
    renewedAt = at
    try {
      await sandbox.setTimeout(lifetime)
    }
    catch (error) {
      console.warn(`sandbox-e2b: could not renew sandbox lifetime: ${String(error)}`)
    }
  }

  /**
   * Judge a process from the journal, conservatively.
   *
   * The ordering is the whole substance of this function, because `run-workflow.ts` reads
   * only `state === 'running'` as alive: `'error'` is indistinguishable from `'exited'`
   * there, and a healthy turn misjudged as dead makes `liveTurnProcess` decline to adopt it
   * and `sandbox.exec` a *second* `claude` turn on the same repository. So:
   *
   * 1. an exit file settles it — the process ended, whatever e2b thinks;
   * 2. `'live'` is running;
   * 3. `'unknown'` is *also* running, on purpose. An unobservable process is not an
   *    evidently-dead one, and the two mistakes are not symmetric: guessing "running" wrong
   *    costs one more re-check on the next poll, guessing "dead" wrong starts a duplicate
   *    turn;
   * 4. `'gone'` re-reads the exit file first. Steps 1 and 2 are a network round trip apart
   *    and this is sampled repeatedly per turn, so a process exiting inside that window is
   *    an ordinary event, not a rare race. Only a second miss is `no_exit_record`.
   */
  async function statusOf(meta: JournalMeta): Promise<ProcessStatus> {
    const paths = journalPaths(root, meta.id)

    // The exit file is a claim, not proof. It lives in the sandbox the turn itself runs in
    // and can write to, and this repository treats what a turn acts on as untrusted, so a
    // prompt-injected or merely buggy turn can journal an exit for itself while it is still
    // running. Believing that would report the attempt finished, free the checkout for a
    // retry, and let a second `claude` start beside the first. e2b's own process table is
    // the part the turn cannot forge, so nothing is terminal until that says the pid is
    // gone (codex review, PR #260).
    const code = await readExitCode(paths)
    const listed = await listedWrapper(meta.id)
    // The argv is read from that same table for the same reason. `liveTurnProcess` matches a
    // discovered process by its `command`, and the meta file is the turn's to rewrite: a turn
    // that edited its own would be unrecognisable to the duplicate-turn guard and get a
    // second `claude` started beside it. The journal answers only once e2b no longer lists
    // the wrapper — by then the process has exited, and an exited one is never adopted.
    const base = {
      id: meta.id,
      pid: meta.pid,
      command: listed?.commandLine === undefined ? meta.command : recoveredCommand(listed.commandLine),
      cwd: meta.cwd,
      startedAt: meta.startedAt,
    }
    const exited = (code: number): ProcessStatus =>
      ({ ...base, state: 'exited', exit: { code, timedOut: false }, endedAt: now() })

    if (livenessFrom(listed) !== 'gone') {
      return { ...base, state: 'running' }
    }
    const settled = code ?? await readExitCode(paths)
    if (settled !== undefined) {
      return exited(settled)
    }
    // Gone from e2b's table and still no exit file on a second read: the wrapper died before
    // recording `$?`, which is a failure the run must see rather than a turn that quietly
    // never ends.
    return {
      ...base,
      state: 'error',
      error: { code: 'no_exit_record', message: 'process is not running and journalled no exit code' },
      endedAt: now(),
    }
  }

  function handleFor(meta: JournalMeta): SandboxProcessHandle {
    const paths = journalPaths(root, meta.id)

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
      const exitCode = await readExitCode(paths)
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

    return {
      id: meta.id,
      status: () => statusOf(meta),
      logs: async (logOptions) => {
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
        // Pulled rather than pushed: enqueuing eagerly would buffer the transcript inside
        // the stream, which is the thing being avoided.
        const events = wholeTranscript()
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
            await events.return(reason)
          },
        })
      },
      waitForExit: options => waitForExit(meta, options),
      kill: async () => {
        const listed = await listedWrapper(meta.id)
        if (listed?.pid === undefined) {
          // e2b is running nothing for this process, or could not say. Either way there is
          // no trustworthy pid to aim at, and the journal's is the turn's to choose.
          return
        }
        await killTree(listed.pid)
      },
    }
  }

  /**
   * Resolve only from a journalled exit code; reject on every other ending.
   *
   * The contract requires it (see `WaitForExitOptions`): callers use the `catch` as their
   * timeout path, so resolving a synthetic exit would report a live process as dead. The
   * two rejections are kept distinguishable because they mean opposite things to a caller —
   * {@link SandboxWaitTimeoutError} says "still running, wait longer or kill it", while the
   * `no_exit_record` failure says "it is already gone, retrying the wait buys nothing".
   *
   * **Without a `timeout` there is no deadline at all**, and `SandboxWaitTimeoutError` is
   * unreachable. `awaitTurn` in `run-workflow.ts` races an unbounded `waitForExit()` inside
   * a step that already allows a live turn six hours, and documents that such a wait never
   * rejects — so any cap invented here would escape that race, escape a step that is never
   * retried, and fail a run whose turn was merely long. Claude turns past half an hour are
   * ordinary. What keeps a *lost* process from hanging the step is the `'gone'` check
   * below, which is a real observation rather than a guess dressed up as a limit.
   */
  async function waitForExit(
    meta: JournalMeta,
    waitOptions?: { timeout?: number, signal?: AbortSignal },
  ): Promise<ProcessExit> {
    const paths = journalPaths(root, meta.id)
    const startedAt = elapsedMs()
    const timeout = waitOptions?.timeout
    const deadline = timeout === undefined ? undefined : startedAt + timeout
    let nextProbeAt = startedAt
    let claimed = false
    while (true) {
      const code = await readExitCode(paths)
      const at = elapsedMs()
      if (code !== undefined && !claimed) {
        // First sighting of an exit record: confirm it now rather than at the next
        // scheduled probe. The wrapper writes `$?` microseconds before its shell exits, so
        // by the time a network read has returned the file the pid is normally already
        // gone and this costs one probe. Forced once, so a *forged* exit file cannot turn
        // the rest of the wait into a probe every poll interval.
        claimed = true
        nextProbeAt = at
      }
      if (waitOptions?.signal?.aborted === true || (deadline !== undefined && at >= deadline)) {
        throw new SandboxWaitTimeoutError(meta.id, timeout ?? at - startedAt)
      }
      if (at >= nextProbeAt) {
        nextProbeAt = at + LIVENESS_PROBE_INTERVAL_MS
        // The only way out of this loop with an exit code, for the reason `statusOf` gives:
        // the exit file is writable by the turn, e2b's process table is not. A crashed
        // wrapper leaves no exit file ever, so polling alone would wait out the caller's
        // budget — or, unbounded, forever — and then report something the caller cannot
        // tell from a merely slow turn. Re-read once first, for the round-trip window
        // between the wrapper's `printf` and its shell exiting.
        if (await livenessOf(meta.id) === 'gone') {
          const settled = await readExitCode(paths)
          if (settled !== undefined) {
            return { code: settled, timedOut: false }
          }
          throw new SandboxNoExitRecordError(meta.id)
        }
        await renewSandboxLifetime()
      }
      const remaining = deadline === undefined ? pollMs : Math.min(pollMs, deadline - elapsedMs())
      await new Promise(resolve => setTimeout(resolve, Math.max(0, remaining)))
    }
  }

  return {
    ...createE2bFiles(sandbox),
    exec: async (command: SandboxCommand, execOptions?: SandboxExecOptions) => {
      const id = newProcessId()
      const paths = journalPaths(root, id)
      // Verified rather than trusted: `makeDir`'s result conflates "created" with "already
      // there" differently across e2b versions, and a root that is missing or unwritable
      // fails *silently* — the wrapper's redirection dies, so the wrapped command never
      // runs, and the caller learns only much later that the transcript is empty. Better a
      // named error from `exec` than a handle to a process that was never started.
      await sandbox.files.makeDir(root).catch(() => false)
      if (!await sandbox.files.exists(root)) {
        throw new Error(`journal root '${root}' does not exist and could not be created`)
      }
      const started = await sandbox.commands.run(journalledCommand(command, paths), {
        background: true,
        cwd: execOptions?.cwd,
        envs: execOptions?.env,
        timeoutMs: commandTimeoutMs,
      })
      const meta: JournalMeta = {
        id,
        pid: started.pid,
        command: [...command],
        cwd: execOptions?.cwd,
        startedAt: now(),
      }
      // Written host-side because the pid is only known once `run` returns, and the pid is
      // what `kill` and every liveness check key on. A failed write would therefore leave a
      // turn running that nothing can name: no handle is returned, `getProcess` finds no
      // meta, and `listProcesses` cannot see it either — so the watchdog cannot kill it and
      // the duplicate-turn guard cannot count it. Kill it here instead, then report, so the
      // caller's failure is a turn that did not start rather than one nobody owns
      // (gemini review, PR #260).
      try {
        await sandbox.files.write(paths.meta, serializeJournalMeta(meta))
      }
      catch (cause) {
        // The tree, not the shell: `commands.kill` leaves the wrapped command running
        // (measured, `scripts/spike-e2b-kill-tree.ts`), and materialization is retried — so
        // a transient meta-write failure would race the retry against an orphaned clone in
        // the same checkout (codex review, PR #260).
        await killTree(started.pid)
        throw cause
      }
      return handleFor(meta)
    },

    getProcess: async (id: string) => {
      const meta = metaMatching(id, await readMeta(id))
      if (meta) {
        return handleFor(meta)
      }
      // No usable meta — deleted, corrupted, or renamed, all of which the turn can do, and a
      // transient read failure looks the same from here. `null` is read as a confirmed death,
      // so ask e2b before saying it.
      const recovered = (await recoveredProcesses()).get(id)
      if (recovered) {
        return handleFor(recovered)
      }
      // e2b forgets an exited process, so a finished turn is absent from both records while
      // its transcript is still on disk. `settleRun` replays that transcript through this
      // lookup: answering `null` records a turn that succeeded as one whose logs could not be
      // read (codex review, PR #260). The journal files are what say it ran.
      return await journalled(id) ? handleFor(withoutMeta(id)) : null
    },

    listProcesses: async () => {
      const entries = await journalEntries()
      // The journal root is a plain directory, so a foreign filename can land in it — and a
      // benign one at that (`2026-08-24.log`). Screened here rather than left to
      // `journalPaths`, whose throw would escape the whole listing and take the valid
      // entries with it, inside a workflow step that is never retried.
      const ids = entries
        .map(entry => entry.name)
        .filter(name => name.endsWith(META_SUFFIX))
        .map(name => name.slice(0, -META_SUFFIX.length))
        .filter(isProcessId)
      const metas = await Promise.all(ids.map(readListedMeta))
      // The journal names what has *run*; e2b names what is *running*. Unioned because
      // neither is complete on its own: an exited process is only in the journal, and one
      // whose meta the turn erased is only in e2b's listing — and that second gap is the
      // one `liveTurnProcess` would meet as "no turn is running here".
      const byId = await recoveredProcesses()
      for (const meta of metas) {
        if (meta) {
          byId.set(meta.id, meta)
        }
      }
      return Promise.all([...byId.values()].map(statusOf))
    },

    exists: async (path: string) => ({ exists: await sandbox.files.exists(path) }),

    destroy: async () => {
      await sandbox.kill()
    },
  }
}
