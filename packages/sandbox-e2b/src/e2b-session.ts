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
import { createKillPath } from './e2b-kill'
import { isProcessId, journalledCommand, journalPaths, serializeJournalMeta } from './journal'
import { createJournalIo } from './journal-io'
import { createLifetimeRenewer } from './lifetime'
import { createProcessLogs } from './log-reads'
import { createWrapperTable, livenessFrom } from './wrapper-table'

export type { E2bCommandHandle, E2bFileRead, E2bSandboxLike } from './e2b-surface'

const META_SUFFIX = '.meta.json'
const DEFAULT_POLL_MS = 250
/**
 * How long a following `logs()` waits after a poll that found nothing new.
 *
 * A second, not `DEFAULT_POLL_MS`: every poll transfers the whole journal file, and the caller
 * this exists for — the AI SDK bridge's startup banner, via `@pleaseai/harness-sandbox` — is
 * bounded by the harness's own readiness timeout of two minutes rather than by this cadence.
 */
const DEFAULT_FOLLOW_MS = 1_000

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

export interface E2bSessionOptions {
  /** Directory the journal lives in. Created on first `exec`. */
  journalRoot: string
  newProcessId?: () => string
  now?: () => string
  /** How often `waitForExit` re-reads the exit file. */
  pollIntervalMs?: number
  /**
   * How often a following `logs()` re-reads the journal.
   *
   * Its own interval rather than {@link pollIntervalMs}, because the two loops read different
   * things: the wait re-reads a four-byte exit file, a tail re-transfers the whole journal —
   * e2b has no byte-range read. Defaults to {@link DEFAULT_FOLLOW_MS}.
   */
  followIntervalMs?: number
  /**
   * The shortest gap between two liveness probes inside a following `logs()`.
   *
   * Slower than {@link followIntervalMs} because the probe is two remote calls rather than a
   * file read, and defaulting to the same `LIVENESS_PROBE_INTERVAL_MS` the wait loop spends on
   * the identical question. Injected so a test can reach the verdict without spending it.
   */
  followLivenessIntervalMs?: number
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
  /** Lifetime re-applied to the sandbox while a wait is in flight. Unset disables renewal. */
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
  const followMs = options.followIntervalMs ?? DEFAULT_FOLLOW_MS
  const followLivenessMs = options.followLivenessIntervalMs ?? LIVENESS_PROBE_INTERVAL_MS
  const elapsedMs = options.monotonicNowMs ?? (() => Date.now())
  const commandTimeoutMs = options.commandTimeoutMs ?? 0
  // Trailing slashes stripped the way `journalPaths` strips them, so the prefix
  // `journalIdIn` matches against is the one that actually appears in a wrapper's argv.
  const root = options.journalRoot.replace(/\/+$/, '')

  const journal = createJournalIo(sandbox, root)
  const { entries: journalEntries, metaMatching, readExitCode, readListedMeta } = journal
  const { readEndOffset, readMeta, readSliceFrom, streamFile } = journal
  const table = createWrapperTable(sandbox, root, now)
  const { killTree, listedWrapper, livenessOf, recoveredCommand, recoveredProcesses } = table
  const { confirmReaped, killSession, sessionSurvivors } = table
  const { forgetExecPid, killProcess, rememberExecPid, sessionPid } = createKillPath({
    confirmReaped,
    killSession,
    killTree,
    listedWrapper,
    sessionSurvivors,
  })
  const renewSandboxLifetime = createLifetimeRenewer(sandbox, {
    lifetime: options.sandboxTimeoutMs,
    floorMs: LIVENESS_PROBE_INTERVAL_MS,
    elapsedMs,
  })

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
    const exited = (code: number): ProcessStatus => {
      forgetExecPid(meta.id)
      return { ...base, state: 'exited', exit: { code, timedOut: false }, endedAt: now() }
    }

    if (livenessFrom(listed) !== 'gone') {
      return { ...base, state: 'running' }
    }
    // Gone from e2b's table is not the same as over: e2b lists only what it started itself,
    // so a child the turn detached and then orphaned is invisible to that table while it
    // keeps writing to the checkout. `running` is the honest reading of a session that is not
    // empty — the turn's work demonstrably has not stopped, and calling it finished is what
    // frees the checkout for a second `claude` (#266). `'unknown'` lands there too, by step
    // 3's asymmetry. What this does and does not bind is argued at `sessionSurvivors`; the
    // short of it is that the session id comes from `meta.pid`, so a turn that rewrites or
    // deletes its meta is outside the guard's reach and one that only forges an exit is not.
    if (await sessionSurvivors(sessionPid(meta)) !== 'none') {
      return { ...base, state: 'running' }
    }
    const settled = code ?? await readExitCode(paths)
    if (settled !== undefined) {
      return exited(settled)
    }
    // Gone from e2b's table and still no exit file on a second read: the wrapper died before
    // recording `$?`, which is a failure the run must see rather than a turn that quietly
    // never ends.
    forgetExecPid(meta.id)
    return {
      ...base,
      state: 'error',
      error: { code: 'no_exit_record', message: 'process is not running and journalled no exit code' },
      endedAt: now(),
    }
  }

  function handleFor(meta: JournalMeta): SandboxProcessHandle {
    const paths = journalPaths(root, meta.id)

    return {
      id: meta.id,
      status: () => statusOf(meta),
      logs: createProcessLogs({
        paths,
        readExitCode: () => readExitCode(paths),
        readSliceFrom,
        readEndOffset,
        streamFile,
        // The same verdict `waitForExit` ends on, composed here rather than re-derived: gone
        // from e2b's table *and* no survivor in the wrapper's own session. A follow read that
        // trusted the journal alone would end on an exit the turn can write for itself, and
        // never end at all when a killed wrapper writes none (code review, PR #280).
        isGone: async () =>
          await livenessOf(meta.id) === 'gone' && await sessionSurvivors(sessionPid(meta)) === 'none',
        now,
        elapsedMs,
        followIntervalMs: followMs,
        livenessIntervalMs: followLivenessMs,
      }),
      waitForExit: options => waitForExit(meta, options),
      kill: signal => killProcess(meta, signal),
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
        //
        // Gated on the wrapper's session, and on *both* endings rather than only the resolve:
        // `awaitTurn` reaches an exit through this loop and not through `status()`, so this is
        // the path #266's forgery actually takes, and the `no_exit_record` throw is what
        // `killTurn` meets after a fallback kill leaves a reparented child and no `$?`.
        //
        // A survivor is neither ending. It is not a journalled exit — the contract forbids
        // synthesising one — and it is not a process gone for good, so the loop keeps going
        // and the *caller's* deadline decides. A bounded wait then ends in
        // `SandboxWaitTimeoutError`, which says "still running, wait longer or kill it":
        // exactly true here, and already read as an unconfirmed kill. An unbounded one keeps
        // waiting, which is what `awaitTurn` wants — it races this against the watchdog, and a
        // turn still writing to the checkout is precisely what must not settle. Short-circuited
        // behind the liveness verdict and inside the interval block, so it costs at most one
        // command per `LIVENESS_PROBE_INTERVAL_MS` and never one per poll.
        if (await livenessOf(meta.id) === 'gone' && await sessionSurvivors(sessionPid(meta)) === 'none') {
          const settled = await readExitCode(paths)
          forgetExecPid(meta.id)
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
      // Remembered before anything can fail: from here on this session can aim a kill at the
      // process even when e2b stops listing its wrapper, and `getProcess` inherits that.
      rememberExecPid(id, started.pid)
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
        if (await killTree(started.pid) === 'reaped') {
          throw cause
        }
        // The reap fell back, so the tree may still be running — and nothing can name it,
        // which is the whole reason this path kills at all. Said in the error rather than
        // left as the plain write failure, whose remedy (retry) is the wrong one while a
        // process may still be writing to that checkout.
        throw new Error(
          `journal meta for '${id}' could not be written and its wrapper (pid ${String(started.pid)})`
          + ` could not be reaped; it may still be running`,
          { cause },
        )
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
