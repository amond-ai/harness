/**
 * The Daytona backend for {@link SandboxSession}.
 *
 * **Why this one is thin where the e2b backend is not.** e2b forgets a process the moment it
 * exits (research note 027), so that backend has to journal the transcript and the exit code to
 * the sandbox filesystem — and then defend that journal, because the turn can write to it: every
 * verdict there is a file the turn could forge cross-checked against a process table it could
 * not. Daytona's toolbox daemon keeps both. `getSessionCommand(sessionId, cmdId).exitCode` is
 * still answerable after the command finishes and is written *by the daemon*, and
 * `getSessionCommandLogs` retains stdout and stderr separately past exit (research note 035 §3).
 * There is nothing for a turn to forge, so there is no journal, no wrapper table and no kill
 * walk here — one read settles liveness and exit together.
 *
 * **Identity.** One Daytona session per process: the contract's process id *is* the session id,
 * minted here. That is what makes a cold provider work — a retried workflow step on another
 * instance recovers the command id from `getSession(id).commands[0].id` with nothing but the id
 * the caller already has.
 *
 * What Daytona does *not* carry is a pid, a signal API, or the argv of a command once you are
 * holding only its id. `daytona-process.ts` supplies all three out of the wrapper script and one
 * meta file; `daytona-kill.ts` spends the pid.
 */
import type {
  ProcessExit,
  ProcessStatus,
  SandboxCommand,
  SandboxExecOptions,
  SandboxProcessHandle,
  SandboxSession,
} from '@amond-ai/sandbox'
import type { ProcessMeta } from './daytona-process'
import type { DaytonaSandboxLike } from './daytona-surface'
import type { ProcessEnding } from './log-reads'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '@amond-ai/sandbox'
import { createDaytonaFiles } from './daytona-files'
import { createKillPath } from './daytona-kill'
import { isProcessId, parseProcessMeta, processPaths, serializeProcessMeta, wrappedCommand } from './daytona-process'
import { createCommandReader, NO_EXIT_RECORD } from './daytona-status'
import { isNotFound } from './daytona-surface'
import { createProcessLogs } from './log-reads'

export type { DaytonaSandboxLike, DaytonaSession, DaytonaSessionCommand } from './daytona-surface'

/** How often a wait re-asks the daemon whether the command has finished. */
const DEFAULT_POLL_MS = 1_000
/** How often a following `logs()` re-reads the command's output. */
const DEFAULT_FOLLOW_MS = 1_000
/** The mode a state-root directory the sandbox's own shell must write into needs. */
const STATE_ROOT_MODE = '755'

export interface DaytonaSessionOptions {
  /** Directory the pid and meta files live in, inside the sandbox. Created on first `exec`. */
  stateRoot: string
  newProcessId?: () => string
  now?: () => string
  /** How often `waitForExit` re-reads the command. Defaults to {@link DEFAULT_POLL_MS}. */
  pollIntervalMs?: number
  /** How often a following `logs()` polls. Defaults to {@link DEFAULT_FOLLOW_MS}. */
  followIntervalMs?: number
  /**
   * Monotonic milliseconds. Injected only so a wait's deadline — and the absence of one — can be
   * exercised without spending the wall-clock time it would otherwise take.
   */
  monotonicNowMs?: () => number
}

export function createDaytonaSession(
  sandbox: DaytonaSandboxLike,
  options: DaytonaSessionOptions,
): SandboxSession {
  const newProcessId = options.newProcessId ?? (() => crypto.randomUUID())
  const now = options.now ?? (() => new Date().toISOString())
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS
  const followMs = options.followIntervalMs ?? DEFAULT_FOLLOW_MS
  const elapsedMs = options.monotonicNowMs ?? (() => Date.now())
  const root = options.stateRoot.replace(/\/+$/, '')

  const reader = createCommandReader(sandbox)
  const { killProcess } = createKillPath(sandbox, root)

  /**
   * The least that can be said about a process whose meta is gone.
   *
   * `command` is required by `ProcessStatus` and cannot be recovered — Daytona's `Command` holds
   * the *wrapper* string, and reading argv back out of a shell word list is a parser this package
   * deliberately does not carry (`shell-quote.ts`). Named for what it is rather than guessed at.
   */
  function withoutMeta(id: string): ProcessMeta {
    return { id, command: ['<unrecorded>'], startedAt: now() }
  }

  /**
   * The meta file, or `undefined` when Daytona says there is none.
   *
   * A 404 is an absence; anything else propagates, because `getProcess` turns "no meta and no
   * session" into `null` and a caller reads that as a confirmed death. A file that is there but
   * unparseable is still evidence the process existed, so it degrades to {@link withoutMeta}
   * rather than to absence.
   */
  async function readMeta(id: string): Promise<ProcessMeta | undefined> {
    let bytes: Uint8Array
    try {
      bytes = await sandbox.fs.downloadFile(processPaths(root, id).meta)
    }
    catch (cause) {
      if (isNotFound(cause)) {
        return undefined
      }
      throw cause
    }
    return parseProcessMeta(bytes, id) ?? withoutMeta(id)
  }

  async function statusOf(meta: ProcessMeta): Promise<ProcessStatus> {
    const base = {
      id: meta.id,
      // Daytona exposes no pid for a session command and no caller of this contract reads one;
      // the real pid lives in `<stateRoot>/<id>.pid` for the kill path, and fetching it here
      // would add a file read to every poll of every wait to fill a field nobody looks at.
      pid: 0,
      command: meta.command,
      cwd: meta.cwd,
      startedAt: meta.startedAt,
    }
    const verdict = await reader.verdict(meta.id)
    if (verdict.kind === 'running') {
      return { ...base, state: 'running' }
    }
    if (verdict.kind === 'exited') {
      // `timedOut` is always false: Daytona applies no server-side budget to a `runAsync`
      // command, so an exit here is the command's own (research note 035 §3).
      return { ...base, state: 'exited', exit: { code: verdict.code, timedOut: false }, endedAt: now() }
    }
    return { ...base, state: 'error', error: NO_EXIT_RECORD, endedAt: now() }
  }

  async function endingOf(id: string): Promise<ProcessEnding | undefined> {
    const verdict = await reader.verdict(id)
    if (verdict.kind === 'running') {
      return undefined
    }
    return verdict.kind === 'exited'
      ? { state: 'exited', exit: { code: verdict.code, timedOut: false } }
      : { state: 'error', error: NO_EXIT_RECORD }
  }

  /**
   * Resolve only from an exit the daemon recorded; reject on every other ending.
   *
   * The contract requires it (see `WaitForExitOptions`): callers use the `catch` as their timeout
   * path, so resolving a synthetic exit would report a live process as dead. The two rejections
   * are kept distinguishable because they mean opposite things — {@link SandboxWaitTimeoutError}
   * says "still running, wait longer or kill it", while `no_exit_record` says "it is already
   * gone, retrying the wait buys nothing".
   *
   * **Without a `timeout` there is no deadline at all**, and {@link SandboxWaitTimeoutError} is
   * unreachable. `awaitTurn` in `run-workflow.ts` races an unbounded `waitForExit()` inside a
   * step that already allows a live turn six hours, so any cap invented here would fail a run
   * whose turn was merely long.
   *
   * The poll costs one `getSessionCommand` and nothing else. There is deliberately no lifetime
   * renewer beside it, unlike the e2b backend's: Daytona's `autoStopInterval` counts *inactivity*
   * against the sandbox, and this loop is activity — a turn being waited on is a sandbox being
   * used.
   */
  async function waitForExit(
    id: string,
    waitOptions?: { timeout?: number, signal?: AbortSignal },
  ): Promise<ProcessExit> {
    const startedAt = elapsedMs()
    const timeout = waitOptions?.timeout
    const deadline = timeout === undefined ? undefined : startedAt + timeout
    while (true) {
      const verdict = await reader.verdict(id)
      if (verdict.kind === 'exited') {
        return { code: verdict.code, timedOut: false }
      }
      if (verdict.kind === 'gone') {
        throw new SandboxNoExitRecordError(id)
      }
      const at = elapsedMs()
      if (waitOptions?.signal?.aborted === true || (deadline !== undefined && at >= deadline)) {
        throw new SandboxWaitTimeoutError(id, timeout ?? at - startedAt)
      }
      const remaining = deadline === undefined ? pollMs : Math.min(pollMs, deadline - elapsedMs())
      await new Promise(resolve => setTimeout(resolve, Math.max(0, remaining)))
    }
  }

  function handleFor(meta: ProcessMeta): SandboxProcessHandle {
    return {
      id: meta.id,
      status: () => statusOf(meta),
      logs: createProcessLogs({
        readLogs: () => reader.logs(meta.id),
        ending: () => endingOf(meta.id),
        now,
        followIntervalMs: followMs,
      }),
      waitForExit: waitOptions => waitForExit(meta.id, waitOptions),
      kill: signal => killProcess(meta.id, signal),
    }
  }

  /**
   * Verified rather than trusted, the way the e2b backend verifies its journal root.
   *
   * `createFolder` on a directory that is already there is not documented either way and may
   * reject, so the rejection is swallowed and the existence re-checked. A missing state root
   * fails *silently* otherwise: the wrapper's `printf … > <root>/<id>.pid` redirection dies, the
   * shell never reaches the command, and the caller learns only much later that the turn produced
   * nothing.
   */
  async function ensureStateRoot(): Promise<void> {
    await sandbox.fs.createFolder(root, STATE_ROOT_MODE).catch(() => undefined)
    try {
      await sandbox.fs.getFileDetails(root)
    }
    catch (cause) {
      throw new Error(`state root '${root}' does not exist and could not be created`, { cause })
    }
  }

  async function exists(path: string): Promise<boolean> {
    try {
      await sandbox.fs.getFileDetails(path)
      return true
    }
    catch (cause) {
      // Only "there is nothing there" is `false`. A permission failure or a dead transport must
      // not read as absence — the harness uses this to decide whether a bundle needs installing.
      if (isNotFound(cause)) {
        return false
      }
      throw cause
    }
  }

  return {
    ...createDaytonaFiles(sandbox),

    exec: async (command: SandboxCommand, execOptions?: SandboxExecOptions) => {
      const id = newProcessId()
      const paths = processPaths(root, id)
      await ensureStateRoot()
      await sandbox.process.createSession(id)
      let started: { cmdId: string }
      try {
        started = await sandbox.process.executeSessionCommand(id, {
          command: wrappedCommand({ command, pidPath: paths.pid, cwd: execOptions?.cwd, env: execOptions?.env }),
          runAsync: true,
        })
      }
      catch (cause) {
        // The session outlives the command that failed to start, and nothing else will ever
        // name it: the id is minted here and no meta file was written, so `listProcesses` cannot
        // see it and `destroy` only reaches sessions the sandbox still lists. Deleting it here is
        // the one moment it is still addressable — for the same reason the meta-write failure
        // below kills the turn it can no longer account for.
        await sandbox.process.deleteSession(id).catch((deleteCause: unknown) => {
          // Warned rather than swallowed: a delete that also fails leaves a session nothing in
          // this backend can name again — `listProcesses` screens on the meta file, `destroy`
          // only reaches what the sandbox still lists — so a log line is the only thing an
          // operator has to search when sessions accumulate (cubic review, PR #463).
          console.warn(`daytona could not delete orphaned session '${id}': ${String(deleteCause)}`)
        })
        throw cause
      }
      // Remembered before anything can fail, so this session answers `status()` without paying
      // for a `getSession` it already knows the answer to.
      reader.remember(id, started.cmdId)
      const meta: ProcessMeta = { id, command: [...command], cwd: execOptions?.cwd, startedAt: now() }
      try {
        await sandbox.fs.uploadFileStream(serializeProcessMeta(meta), paths.meta)
      }
      catch (cause) {
        // A failed meta write leaves a turn running that `listProcesses` cannot see — it screens
        // on the meta file — so the duplicate-turn guard would start a second `claude` in the
        // same checkout. Kill it here instead, then report, so the caller's failure is a turn
        // that did not start rather than one nobody owns.
        await killProcess(id).catch(() => undefined)
        // The kill ends the process; it does not end the session holding it, and `killProcess`
        // only reaches `deleteSession` on the branch where no pid was recorded. Without this the
        // session survives its own dead command, unscreenable for the same reason — no meta file
        // — until `destroy()` takes the whole sandbox with it (gemini review, PR #463).
        await sandbox.process.deleteSession(id).catch((deleteCause: unknown) => {
          console.warn(`daytona could not delete orphaned session '${id}': ${String(deleteCause)}`)
        })
        throw new Error(`process meta for '${id}' could not be written; its command was killed`, { cause })
      }
      return handleFor(meta)
    },

    getProcess: async (id: string) => {
      if (!isProcessId(id)) {
        return null
      }
      const verdict = await reader.verdict(id)
      if (verdict.kind !== 'gone') {
        // Best-effort: the meta only fills `command`/`cwd`/`startedAt`, and the process is
        // demonstrably there whether or not its file is.
        return handleFor(await readMeta(id).catch(() => undefined) ?? withoutMeta(id))
      }
      // Daytona has forgotten the session — a sandbox stopped and restarted is not documented to
      // keep one (research note 035 §3). A meta file still on disk says the process existed, so
      // it gets a handle whose `status()` is the `no_exit_record` error rather than `null`, which
      // `killTurn` would read as a confirmed death.
      const meta = await readMeta(id)
      return meta ? handleFor(meta) : null
    },

    listProcesses: async () => {
      const sessions = await sandbox.process.listSessions()
      // A sandbox's session list is shared ground: the entrypoint session is always there, and a
      // turn can create its own. Screened rather than thrown on, so one foreign id cannot take
      // the whole listing with it inside a workflow step that is never retried.
      const ours = sessions.map(session => session.sessionId).filter(isProcessId)
      const metas = await Promise.all(ours.map(id => readMeta(id).catch(() => undefined)))
      return Promise.all(metas.filter((meta): meta is ProcessMeta => meta !== undefined).map(statusOf))
    },

    exists: async (path: string) => ({ exists: await exists(path) }),

    destroy: async () => {
      await sandbox.delete()
    },
  }
}
