/**
 * The Vercel backend for {@link SandboxSession}.
 *
 * Where the Cloudflare backend is a naming layer over a client that already has the right
 * semantics, this one supplies semantics `@vercel/sandbox` does not have. A sandbox exposes no
 * process list at all, and a command id is scoped to the *session* that ran it — so a sandbox
 * resumed into a new VM, which is the ordinary state a retried workflow step reattaches to,
 * cannot resolve a single handle it was given before. Every question the run workflow asks after
 * a turn ends — its transcript, its exit code, whether it ran at all — therefore has no Vercel
 * answer. The journal of `journal.ts` is the answer, and this file is the part that decides what
 * it means.
 *
 * The reading lives in the modules either side of this one, split along the trust boundary the
 * whole backend turns on: `journal-io.ts` reads what a turn wrote down, and `vercel-probe.ts`
 * reads what the kernel still has running. `log-reads.ts` owns `logs()`, and `vercel-kill.ts`
 * owns the kill ladder — both split out for the reason their siblings were, that this file is
 * near the repository's 500-LOC limit.
 *
 * **One honest caveat, because it is a real difference from the e2b backend.** e2b lists a live
 * process's argv, so `statusOf` can report a command line the turn cannot rewrite. Vercel
 * exposes no argv, so `ProcessStatus.command` here comes from `<id>.meta.json` — a file in the
 * sandbox the turn itself can write to. It is therefore turn-writable: weaker than e2b, equal to
 * Daytona. What keeps that from mattering is that nothing load-bearing reads it. The liveness
 * verdict comes from the probe, which compares `/proc/<pgid>/cmdline` against the marker
 * `wrapperMarker()` derives from the process *id* — not from the meta, and not from anything the
 * command line says.
 */
import type {
  ProcessExit,
  ProcessStatus,
  SandboxCommand,
  SandboxExecOptions,
  SandboxProcessHandle,
  SandboxSession,
} from '@amond-ai/sandbox'
import type { JournalMeta } from './journal'
import type { VercelCommandLike, VercelSandboxLike } from './vercel-surface'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '@amond-ai/sandbox'
import {
  isProcessId,
  journalledScript,
  journalPaths,
  serializeJournalMeta,
  WRAPPER_SHELL,
} from './journal'
import { createJournalIo } from './journal-io'
import { createLifetimeRenewer } from './lifetime'
import { createProcessLogs } from './log-reads'
import { createVercelFiles, pathExists } from './vercel-files'
import { createVercelKill } from './vercel-kill'
import { createJournalProbe } from './vercel-probe'

const META_SUFFIX = '.meta.json'
/**
 * How often a wait probes, and how often a following `logs()` polls.
 *
 * One interval where the e2b backend needs three (250ms for the exit file, 5s for liveness, 1s
 * for a tail), because one `runCommand` answers every question both loops ask — see
 * `vercel-probe.ts`. A second is the cadence the slowest of those three was already tuned to,
 * and the caller it is tuned for, the AI SDK bridge's startup banner, is bounded by the
 * harness's own readiness timeout of two minutes rather than by this.
 */
const DEFAULT_POLL_MS = 1_000

export interface VercelSessionOptions {
  /** Directory the journal lives in. Created on first `exec`. */
  journalRoot: string
  newProcessId?: () => string
  now?: () => string
  /** How often `waitForExit` probes. Defaults to {@link DEFAULT_POLL_MS}. */
  pollIntervalMs?: number
  /** How often a following `logs()` probes. Defaults to {@link DEFAULT_POLL_MS}. */
  followIntervalMs?: number
  /**
   * Vercel's per-command budget for the *wrapper*, in milliseconds. Unset — the default — leaves
   * the sandbox's own.
   *
   * Not the same thing as `SandboxExecOptions.timeout`, which bounds the wrapped command and is
   * enforced by the watchdog inside the script, where the wrapper survives to record the exit and
   * the timeout marker. This one is enforced by Vercel against the wrapper itself, so a turn it
   * kills journals no `$?` at all and surfaces as {@link SandboxNoExitRecordError} rather than as
   * a timeout — the same trap measured on e2b, whose default 60s budget applies to background
   * commands too.
   */
  commandTimeoutMs?: number
  /** The sandbox's own budget for a probe command, so a wedged probe cannot hang a poll. */
  probeTimeoutMs?: number
  /** The lifetime the sandbox was created with. Unset disables renewal. */
  sandboxTimeoutMs?: number
  /**
   * What one renewal adds, when the plan's cap on a single `extendTimeout` is below
   * {@link sandboxTimeoutMs}. Defaults to it.
   */
  extendTimeoutMs?: number
  /**
   * Whether {@link SandboxSession.destroy} also collects snapshots the sandbox left behind.
   *
   * Nothing in this package asks for a `persistent` sandbox, but a consumer's own
   * `VercelApiOptions.create` can — and a persistent sandbox mints a snapshot nothing else here
   * ever collects. Defaults to `true`.
   */
  deleteOrphanSnapshots?: boolean
  /**
   * Monotonic milliseconds. Injected only so a wait's deadline — and the absence of one — can be
   * exercised without spending the wall-clock time it would otherwise take.
   */
  monotonicNowMs?: () => number
}

export function createVercelSession(
  sandbox: VercelSandboxLike,
  options: VercelSessionOptions,
): SandboxSession {
  const newProcessId = options.newProcessId ?? (() => crypto.randomUUID())
  const now = options.now ?? (() => new Date().toISOString())
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS
  const followMs = options.followIntervalMs ?? DEFAULT_POLL_MS
  const elapsedMs = options.monotonicNowMs ?? (() => Date.now())
  // Trailing slashes stripped the way `journalPaths` strips them, so the prefix a recovered
  // wrapper's argv is matched against is the one that actually appears in it.
  const root = options.journalRoot.replace(/\/+$/, '')

  /**
   * Commands this isolate started, keyed by process id.
   *
   * Host-side and never persisted, which is the point: it is the warm path the probe and the
   * kill ladder short-circuit through, and everything must still work without it — a provider
   * that reattached to an existing sandbox has an empty map and reads the journal instead.
   */
  const execCommands = new Map<string, VercelCommandLike>()

  const io = createJournalIo(sandbox, root)
  const probe = createJournalProbe(sandbox, root, { execCommands, timeoutMs: options.probeTimeoutMs })
  const killProcess = createVercelKill(sandbox, root, io, probe, { execCommands })
  const renewSandboxLifetime = createLifetimeRenewer(sandbox, {
    initialLifetimeMs: options.sandboxTimeoutMs,
    incrementMs: options.extendTimeoutMs,
    floorMs: pollMs,
    elapsedMs,
  })

  /**
   * The least that can be said about a process known only by its journal files.
   *
   * `command` is required by the contract and cannot be recovered — the meta held it and Vercel
   * never had it — so it is named for what it is rather than guessed at.
   */
  function withoutMeta(id: string): JournalMeta {
    return { id, cmdId: '', sessionId: '', command: ['<unrecorded>'], startedAt: now() }
  }

  /**
   * How the process ended, or `undefined` while it may still be running.
   *
   * The same two acceptances `statusOf` makes, in the same order and for the same reasons: a code
   * Vercel corroborated needs no liveness check, and a merely journalled one is believed only
   * once the group is gone. Shared so a `logs()` terminal event and a `status()` can never
   * disagree about whether a turn finished.
   */
  async function exitOf(meta: JournalMeta): Promise<ProcessExit | undefined> {
    const reading = await probe.read(meta)
    if (reading.exitCode === undefined) {
      return undefined
    }
    if (reading.corroborated || reading.liveness === 'gone') {
      return { code: reading.exitCode, timedOut: reading.timedOut }
    }
    return undefined
  }

  /**
   * Judge a process from one probe, conservatively.
   *
   * The ordering is the whole substance of this function, because `run-workflow.ts` reads only
   * `state === 'running'` as alive: `'error'` is indistinguishable from `'exited'` there, and a
   * healthy turn misjudged as dead makes `liveTurnProcess` decline to adopt it and `sandbox.exec`
   * a *second* `claude` turn on the same repository. So:
   *
   * 1. an exit code **Vercel** recorded settles it — that is the API's own account of the command
   *    it started, and the turn cannot forge it;
   * 2. `'live'` is running;
   * 3. `'unknown'` is *also* running, on purpose. An unobservable process is not an
   *    evidently-dead one, and the two mistakes are not symmetric: guessing "running" wrong costs
   *    one more re-check on the next poll, guessing "dead" wrong starts a duplicate turn;
   * 4. `'gone'` re-reads the exit record once. The probe's `head -c` and its liveness branch are
   *    a few microseconds apart inside one script, but the wrapper publishes `$?` and *then* lets
   *    its group empty — so a process that crossed that boundary mid-probe is an ordinary event,
   *    not a rare race. Only a second miss is `no_exit_record`.
   *
   * What is deliberately *not* step 1 is the journal's own `<id>.exit`. It lives in the sandbox
   * the turn runs in and can write to, and this repository treats what a turn acts on as
   * untrusted: a prompt-injected or merely buggy turn can journal an exit for itself while it is
   * still running. Believing that would report the attempt finished, free the checkout for a
   * retry, and let a second `claude` start beside the first. So a journalled code is accepted
   * only at step 4, where the group is already gone.
   */
  async function statusOf(meta: JournalMeta): Promise<ProcessStatus> {
    const paths = journalPaths(root, meta.id)
    const reading = await probe.read(meta)
    const base = {
      id: meta.id,
      // Zero rather than a throw for an unreadable record: `pid` is required by the contract and
      // reported, while the kill path reads the same file itself through `io.readPid` and
      // declines to signal rather than signal a zero.
      pid: await io.readPid(paths.pid) ?? 0,
      command: meta.command,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
    }
    const exited = (code: number): ProcessStatus => {
      execCommands.delete(meta.id)
      return {
        ...base,
        state: 'exited',
        exit: { code, timedOut: reading.timedOut },
        endedAt: now(),
      }
    }

    if (reading.corroborated && reading.exitCode !== undefined) {
      return exited(reading.exitCode)
    }
    if (reading.liveness !== 'gone') {
      return { ...base, state: 'running' }
    }
    const settled = reading.exitCode ?? await io.readExitCode(paths)
    if (settled !== undefined) {
      return exited(settled)
    }
    // Gone and still no exit record on a second read: the wrapper died before recording `$?` —
    // a SIGKILL or an OOM reap — which is a failure the run must see rather than a turn that
    // quietly never ends.
    execCommands.delete(meta.id)
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
        readExit: () => exitOf(meta),
        readSliceFrom: io.readSliceFrom,
        readWhole: io.readWhole,
        probe: () => probe.read(meta),
        now,
        followIntervalMs: followMs,
      }),
      waitForExit: waitOptions => waitForExit(meta, waitOptions),
      kill: signal => killProcess(meta, signal),
    }
  }

  /**
   * Resolve only from a recorded exit code; reject on every other ending.
   *
   * The contract requires it (see `WaitForExitOptions`): callers use the `catch` as their timeout
   * path, so resolving a synthetic exit would report a live process as dead. The two rejections
   * are kept distinguishable because they mean opposite things to a caller —
   * {@link SandboxWaitTimeoutError} says "still running, wait longer or kill it", while
   * {@link SandboxNoExitRecordError} says "it is already gone, retrying the wait buys nothing".
   *
   * **Without a `timeout` there is no deadline at all**, and `SandboxWaitTimeoutError` is
   * reachable only through the caller's `signal`. `awaitTurn` in `run-workflow.ts` races an
   * unbounded `waitForExit()` inside a step that already allows a live turn six hours, and
   * documents that such a wait never rejects — so any cap invented here would escape that race,
   * escape a step that is never retried, and fail a run whose turn was merely long. Claude turns
   * past half an hour are ordinary. What keeps a *lost* process from hanging the step is the
   * `'gone'` branch below, which is a real observation rather than a guess dressed up as a limit.
   *
   * `'unknown'` is neither ending, for step 3's asymmetry in {@link statusOf}. A bounded wait
   * over an unobservable process ends in `SandboxWaitTimeoutError` — "still running, wait longer
   * or kill it", which is exactly what is true — and an unbounded one keeps waiting, which is
   * what `awaitTurn` wants of a turn that may still be writing to the checkout.
   */
  async function waitForExit(
    meta: JournalMeta,
    waitOptions?: { timeout?: number, signal?: AbortSignal },
  ): Promise<ProcessExit> {
    const paths = journalPaths(root, meta.id)
    const startedAt = elapsedMs()
    const timeout = waitOptions?.timeout
    const deadline = timeout === undefined ? undefined : startedAt + timeout
    for (;;) {
      const reading = await probe.read(meta)
      const at = elapsedMs()
      // Ahead of the deadline check because it needs no liveness at all: Vercel has already said
      // how the command ended, and throwing a timeout over a settled exit would report a finished
      // turn as one still running.
      if (reading.corroborated && reading.exitCode !== undefined) {
        execCommands.delete(meta.id)
        return { code: reading.exitCode, timedOut: reading.timedOut }
      }
      if (waitOptions?.signal?.aborted === true || (deadline !== undefined && at >= deadline)) {
        throw new SandboxWaitTimeoutError(meta.id, timeout ?? at - startedAt)
      }
      if (reading.liveness === 'gone') {
        const settled = reading.exitCode ?? await io.readExitCode(paths)
        execCommands.delete(meta.id)
        if (settled !== undefined) {
          return { code: settled, timedOut: reading.timedOut }
        }
        throw new SandboxNoExitRecordError(meta.id)
      }
      // Renewed from this loop rather than per wait: a turn is waited on once and for hours, and
      // the renewer's own floor keeps a fast poll from spending a call per tick.
      await renewSandboxLifetime()
      const remaining = deadline === undefined ? pollMs : Math.min(pollMs, deadline - elapsedMs())
      await new Promise(resolve => setTimeout(resolve, Math.max(0, remaining)))
    }
  }

  /** Process ids the journal names, screened. Throws when the listing was merely unreadable. */
  async function journalledIds(): Promise<string[]> {
    // A foreign filename can land in a plain directory — and a benign one at that
    // (`2026-08-24.log`). Screened here rather than left to `journalPaths`, whose throw would
    // escape the whole listing and take the valid entries with it, inside a workflow step that is
    // never retried. `.exit.pending` is screened by the same suffix test: it is the wrapper's
    // half-published record, not a process.
    return (await io.entries())
      .filter(name => name.endsWith(META_SUFFIX))
      .map(name => name.slice(0, -META_SUFFIX.length))
      .filter(isProcessId)
  }

  return {
    ...createVercelFiles(sandbox),

    exec: async (command: SandboxCommand, execOptions?: SandboxExecOptions) => {
      const id = newProcessId()
      const paths = journalPaths(root, id)
      // Verified rather than trusted: a root that is missing or unwritable fails *silently* —
      // the wrapper's redirection dies, so the wrapped command never runs, and the caller learns
      // only much later that the transcript is empty. Better a named error from `exec` than a
      // handle to a process that was never started.
      await io.ensureRoot()
      // `setsid --wait`, and both halves are load-bearing. `setsid` gives the turn a process
      // group of its own, which is what the default kill reaps and what the probe counts to
      // decide liveness. `--wait` is why this is not a bare `setsid`: that forks and exits
      // immediately, and every turn would report itself finished the moment it started.
      //
      // No `cd` and no `env` prologue — `cwd` and `env` ride Vercel's own params. The argv is
      // exactly what `parseJournalScript` anchors on, so a wrapper recovered from a command line
      // and one started here are the same string.
      const started = await sandbox.runCommand({
        cmd: 'setsid',
        args: ['--wait', WRAPPER_SHELL, '-c', journalledScript(command, paths, execOptions?.timeout)],
        cwd: execOptions?.cwd,
        env: execOptions?.env,
        detached: true,
        timeoutMs: options.commandTimeoutMs,
      })
      // Remembered before anything can fail: from here on this session can ask Vercel how the
      // command ended and aim a kill at it even if the journal never becomes readable.
      execCommands.set(id, started)
      const meta: JournalMeta = {
        id,
        cmdId: started.cmdId,
        // The session as it is *now*, not as it was when the sandbox was created. This is the
        // field that lets a later reader tell "this command id is stale" from "this command is
        // gone", and a sandbox that resumed between creation and this call has already moved on.
        sessionId: sandbox.sessionId() ?? '',
        command: [...command],
        cwd: execOptions?.cwd,
        startedAt: now(),
      }
      try {
        await sandbox.writeFiles([{ path: paths.meta, content: serializeJournalMeta(meta) }])
      }
      catch (cause) {
        // A failed meta write leaves a turn running that nothing can name: no handle is returned,
        // `getProcess` finds no meta, and `listProcesses` screens on the meta file — so the
        // watchdog cannot kill it and the duplicate-turn guard cannot count it. Kill it here
        // instead, then report, so the caller's failure is a turn that did not start rather than
        // one nobody owns.
        await killProcess(meta).catch(() => undefined)
        // The group kill reads `<id>.pgid`, and the wrapper may not have written it yet — this
        // races an `exec` that has only just returned. `Command.kill` is the backstop for exactly
        // that window: it ends the `setsid`, which is the head of the tree, where sending nothing
        // ends nothing at all.
        await started.kill('SIGKILL').catch(() => undefined)
        throw new Error(
          `journal meta for '${id}' could not be written; its wrapper was killed`,
          { cause },
        )
      }
      return handleFor(meta)
    },

    getProcess: async (id: string) => {
      if (!isProcessId(id)) {
        return null
      }
      const meta = io.metaMatching(id, await io.readMeta(id))
      if (meta) {
        return handleFor(meta)
      }
      // No usable meta — deleted, corrupted, or renamed, all of which the turn can do, and a
      // transient read failure looks the same from here. `null` is read as a *confirmed death* by
      // `killTurn`, so ask the journal's other files before saying it: a finished turn's
      // transcript is still on disk long after its meta became unreadable, and `settleRun`
      // replays that transcript through this lookup. Answering `null` there records a turn that
      // succeeded as one whose logs could not be read.
      const paths = journalPaths(root, id)
      const found = await Promise.all([paths.exit, paths.out].map(async path => pathExists(sandbox, path)))
      return found.includes(true) ? handleFor(withoutMeta(id)) : null
    },

    listProcesses: async () => {
      const metas = await Promise.all((await journalledIds()).map(io.readListedMeta))
      return Promise.all(metas.filter((meta): meta is JournalMeta => meta !== undefined).map(statusOf))
    },

    exists: async (path: string) => ({ exists: await pathExists(sandbox, path) }),

    /**
     * End the sandbox, and everything this backend knows is running in it.
     *
     * The kills come first and are not ornamental: `delete` can fail, and a sandbox that survives
     * its own destruction with a `claude` still writing to the checkout is the duplicate-turn
     * hazard in its worst form. A kill that could not be confirmed is carried to the end rather
     * than thrown at once, so one stubborn group cannot stop the others from being reaped.
     *
     * A `delete` that *succeeds* is itself the confirmation — the VM is gone and every process in
     * it with it — so the carried failures are reported only when it does not.
     */
    destroy: async () => {
      const metas = await Promise.all((await journalledIds()).map(io.readListedMeta))
      const unconfirmed: string[] = []
      for (const meta of metas) {
        if (meta === undefined) {
          continue
        }
        await killProcess(meta).catch((cause: unknown) => {
          unconfirmed.push(`${meta.id} (${String(cause)})`)
        })
      }
      try {
        await sandbox.delete({ deleteOrphanSnapshots: options.deleteOrphanSnapshots ?? true })
      }
      catch (cause) {
        if (unconfirmed.length === 0) {
          throw cause
        }
        throw new Error(
          `sandbox could not be deleted and ${String(unconfirmed.length)} process(es) could not be`
          + ` confirmed dead: ${unconfirmed.join(', ')}`,
          { cause },
        )
      }
    },
  }
}
