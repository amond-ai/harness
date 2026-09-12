/**
 * The local backend for {@link SandboxSession}.
 *
 * Where the e2b backend supplies semantics e2b does not have, this one supplies the semantics
 * a *machine* does not have: an operating system has no notion of "the sandbox this run
 * belongs to", no memory of what a process printed once it is gone, and no opinion about which
 * of the processes it is running the orchestrator started. The registry and the journal supply
 * all three, and this file is the part that decides what they mean.
 *
 * The judgements worth reading before changing anything here:
 *
 * - **`'gone'` is the only conclusion that ends a process.** Everything else — running,
 *   unreadable, a pid the host would not answer about — is reported as running, because the two
 *   mistakes are not symmetric. Reporting a dead turn as running costs one more poll; reporting
 *   a live one as dead frees its checkout for a retry, and a second `claude` starts beside the
 *   first.
 * - **Gone means the group is empty, not that the wrapper exited.** A command that detaches a
 *   child and returns leaves that child writing to the checkout. The wrapper is spawned as its
 *   own process-group leader precisely so this question has an answer.
 * - **`waitForExit` resolves only on a journalled exit.** The contract's callers use their
 *   `catch` as the timeout path, so a synthetic exit here would be read as a confirmed death.
 */
import type {
  ProcessExit,
  ProcessStatus,
  SandboxCommand,
  SandboxExecOptions,
  SandboxProcessHandle,
  SandboxSession,
} from '@amond-ai/sandbox'
import type { ProcessRecord } from './journal'
import type { LocalHost } from './local-surface'
import type { SandboxPaths } from './paths'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '@amond-ai/sandbox'
import { journalledScript, journalPaths } from './journal'
import { createJournalIo } from './journal-io'
import { createLocalFiles } from './local-files'
import { createProcessLogs } from './log-reads'
import { resolveWithin } from './paths'
import { createProcessRegistry } from './registry'

/** How often `waitForExit` re-reads the journal. A local read, so it can afford to be brisk. */
const DEFAULT_POLL_MS = 100
/** How long a following `logs()` waits after a read that found nothing new. */
const DEFAULT_FOLLOW_MS = 200
/** POSIX SIGTERM — what a `kill` with no signal named sends, matching the Cloudflare backend. */
const SIGTERM = 15
/** POSIX SIGKILL — what `destroy` sends, because it is releasing rather than asking. */
const SIGKILL = 9

export interface LocalSessionOptions {
  host: LocalHost
  /** Where this sandbox's working directory and state live, and whether the first is ours. */
  paths: SandboxPaths
  /**
   * The environment a command starts with, before `SandboxExecOptions.env` is layered on.
   *
   * Defaults to the orchestrator's own, and that default is a decision rather than a
   * convenience: the `cli` turn driver execs a `claude` the machine already has, so a spawn
   * without `PATH` would not find it. It is also one more way this backend is not a sandbox —
   * a command inherits every credential in the environment that started the app. Pass an
   * explicit map to narrow it.
   */
  env?: Record<string, string>
  newProcessId?: () => string
  now?: () => string
  /** Monotonic milliseconds. Injected so a wait's deadline can be exercised without spending it. */
  monotonicNowMs?: () => number
  pollIntervalMs?: number
  followIntervalMs?: number
  /** How long the registry reuses one "this pid is still ours" answer. */
  identityTtlMs?: number
}

export function createLocalSession(options: LocalSessionOptions): SandboxSession {
  const { host, paths: sandbox } = options
  const newProcessId = options.newProcessId ?? (() => crypto.randomUUID())
  const now = options.now ?? (() => new Date().toISOString())
  const elapsedMs = options.monotonicNowMs ?? (() => Date.now())
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS
  const followMs = options.followIntervalMs ?? DEFAULT_FOLLOW_MS
  const baseEnv = options.env ?? inheritedEnv(host)

  const io = createJournalIo(host)
  const registry = createProcessRegistry({
    host,
    stateDir: sandbox.state,
    now,
    elapsedMs,
    identityTtlMs: options.identityTtlMs,
  })

  /** Is this process, and everything it left running, over? */
  async function isGone(record: ProcessRecord): Promise<boolean> {
    return await registry.survivors(record) === 'none'
  }

  async function statusOf(record: ProcessRecord): Promise<ProcessStatus> {
    const base = {
      id: record.id,
      pid: record.pid,
      command: record.command,
      cwd: record.cwd,
      startedAt: record.startedAt,
    }
    if (!await isGone(record)) {
      return { ...base, state: 'running' }
    }
    const exit = await io.readExit(journalPaths(sandbox.state, record.id))
    if (exit) {
      return { ...base, state: 'exited', exit, endedAt: now() }
    }
    // Nothing of the tree is left and the wrapper recorded no code: it was killed before its
    // `printf` could run. A failure the caller has to see, rather than a process that quietly
    // never ends.
    return {
      ...base,
      state: 'error',
      error: { code: 'no_exit_record', message: 'process is not running and journalled no exit code' },
      endedAt: now(),
    }
  }

  /**
   * Resolve only from a journalled exit; reject on every other ending.
   *
   * **Without a `timeout` there is no deadline at all**, and {@link SandboxWaitTimeoutError} is
   * unreachable — the contract is explicit that a backend may not invent one, because a caller
   * races an unbounded wait inside a step that allows a live turn hours and is never retried.
   * What keeps a *lost* process from hanging that step is the emptiness of its process group,
   * which is an observation rather than a limit dressed up as one.
   */
  async function waitForExit(
    record: ProcessRecord,
    waitOptions?: { timeout?: number, signal?: AbortSignal },
  ): Promise<ProcessExit> {
    const paths = journalPaths(sandbox.state, record.id)
    const startedAt = elapsedMs()
    const timeout = waitOptions?.timeout
    const deadline = timeout === undefined ? undefined : startedAt + timeout
    while (true) {
      const exit = await io.readExit(paths)
      const at = elapsedMs()
      if (waitOptions?.signal?.aborted === true || (deadline !== undefined && at >= deadline)) {
        throw new SandboxWaitTimeoutError(record.id, timeout ?? at - startedAt)
      }
      if (await isGone(record)) {
        // Re-read once: the wrapper's `printf` lands microseconds before its shell exits, so a
        // read taken just before the liveness check can miss a code that is there by now.
        const settled = exit ?? await io.readExit(paths)
        if (settled) {
          return settled
        }
        throw new SandboxNoExitRecordError(record.id)
      }
      const remaining = deadline === undefined ? pollMs : Math.min(pollMs, deadline - elapsedMs())
      await new Promise(resolve => setTimeout(resolve, Math.max(0, remaining)))
    }
  }

  /**
   * Signal the command, not the tree.
   *
   * Aimed at the pid the wrapper wrote down, which is the whole reason it writes one: the
   * contract requires SIGINT to be delivered as asked, and a group-wide SIGINT would take the
   * wrapper shell with it — leaving no `printf` to record the exit, so an interrupt sent to
   * collect a result would destroy the record of one.
   *
   * The command's pid is safe to signal for exactly as long as the wrapper is alive, and not a
   * moment longer: the wrapper is sitting in `wait`, which holds the child's slot even after it
   * becomes a zombie, so that number cannot be reissued to anything else while the wrapper is
   * there. Once the wrapper is gone the only thing left to name is the group, and only what
   * outlived the wrapper is in it.
   */
  async function kill(record: ProcessRecord, signal?: number): Promise<void> {
    const sent = signal ?? SIGTERM
    if (await registry.liveness(record) !== 'gone') {
      const commandPid = await io.readCommandPid(journalPaths(sandbox.state, record.id))
      if (commandPid !== undefined) {
        host.signal(commandPid, sent)
        return
      }
    }
    await registry.signalGroup(record, sent)
  }

  /** Has this id left anything behind — an exit record, or a transcript? */
  async function journalled(id: string): Promise<boolean> {
    const paths = journalPaths(sandbox.state, id)
    const found = await Promise.all([paths.exit, paths.stdout].map(path => host.exists(path)))
    return found.includes(true)
  }

  /**
   * The least that can be said about a process known only by its journal files.
   *
   * `command` is required by {@link ProcessStatus} and cannot be recovered — the record held it
   * and the process is gone from the table — so it is named for what it is rather than guessed
   * at. The pid is `0`, which the registry refuses to signal or probe: a placeholder must not
   * be mistaken for a process, least of all for the caller's own group.
   */
  function withoutRecord(id: string): ProcessRecord {
    return { id, pid: 0, command: ['<unrecorded>'] as unknown as SandboxCommand, startedAt: now() }
  }

  function handleFor(record: ProcessRecord): SandboxProcessHandle {
    const paths = journalPaths(sandbox.state, record.id)
    return {
      id: record.id,
      status: async () => statusOf(record),
      logs: createProcessLogs({
        paths,
        io,
        isGone: async () => isGone(record),
        now,
        followIntervalMs: followMs,
      }),
      waitForExit: async waitOptions => waitForExit(record, waitOptions),
      kill: async signal => kill(record, signal),
    }
  }

  return {
    ...createLocalFiles(host, io, sandbox.work),

    exec: async (command: SandboxCommand, execOptions?: SandboxExecOptions) => {
      const id = newProcessId()
      const paths = journalPaths(sandbox.state, id)
      const cwd = resolveWithin(sandbox.work, execOptions?.cwd ?? '.')
      // Both created and then verified: a state directory that is missing or unwritable fails
      // *silently* otherwise — the wrapper's redirection dies, so the command never runs, and
      // the caller learns only much later that the transcript is empty.
      await registry.ensure()
      await host.mkdir(cwd)
      if (!await host.exists(cwd)) {
        throw new Error(`working directory '${cwd}' does not exist and could not be created`)
      }
      const spawned = await host.spawn({
        script: journalledScript(command, paths, execOptions?.timeout),
        cwd,
        env: { ...baseEnv, ...execOptions?.env },
      })
      const record: ProcessRecord = {
        id,
        pid: spawned.pid,
        command: [...command] as unknown as SandboxCommand,
        cwd,
        startedAt: now(),
        // Read straight after the spawn, before anything can be reused. Absence is tolerated —
        // the record is still worth more than nothing — and `liveness` treats a record without
        // one as unverifiable rather than as verified.
        kernelStartedAt: await host.startedAt(spawned.pid),
      }
      try {
        await registry.remember(record)
      }
      catch (cause) {
        // A record that could not be written leaves a command running that nothing can name:
        // no handle is returned, and discovery would find it only through the process table.
        // Killing it here makes the caller's failure "the process did not start" rather than
        // "something is running in your checkout and nobody owns it".
        await registry.signalGroup(record, SIGKILL)
        throw new Error(
          `process record for '${id}' could not be written; its wrapper (pid ${String(spawned.pid)}) was killed`,
          { cause },
        )
      }
      return handleFor(record)
    },

    /**
     * Discovery, which the contract says must not create anything.
     *
     * Nothing here calls `registry.ensure()`: a state directory that is not there is an answer
     * — no sandbox, nothing running — and creating one to say so would leave a trail of empty
     * directories behind every recovery sweep that asked about a run this machine never had.
     */
    getProcess: async (id: string) => {
      const record = await registry.read(id)
      if (record) {
        return handleFor(record)
      }
      // No usable record: never written, deleted, or corrupted. The process table is asked
      // before answering `null`, which callers read as a confirmed death.
      const recovered = (await registry.recovered()).get(id)
      if (recovered) {
        return handleFor(recovered)
      }
      // A finished process is in neither, while its transcript is still on disk — and a replay
      // of that transcript is how a completed turn is read. The journal is what says it ran.
      return await journalled(id) ? handleFor(withoutRecord(id)) : null
    },

    listProcesses: async () => Promise.all((await registry.list()).map(statusOf)),

    exists: async (path: string) => ({ exists: await host.exists(resolveWithin(sandbox.work, path)) }),

    /**
     * Release the sandbox: end what it is running, then remove what this backend put on disk.
     *
     * The order matters — a working directory removed out from under a live command produces a
     * turn failing in ways nobody can read — and so does the *extent*. This removes the
     * sandbox's own state directory always, and its working directory only when the provider
     * created it. Never the root, and never the state root: those are shared by every other
     * sandbox, and by whatever the consumer caches beside them. That distinction does not exist
     * on a remote backend, where a sandbox is a whole machine; here `destroy()` written as
     * "remove the working directory" is one line and takes the neighbours with it.
     */
    destroy: async () => {
      for (const record of await registry.list()) {
        await registry.signalGroup(record, SIGKILL)
      }
      await host.remove(sandbox.state)
      if (sandbox.owned) {
        await host.remove(sandbox.work)
      }
    },
  }
}

/** The orchestrator's own environment, with the unset entries dropped. */
function inheritedEnv(host: LocalHost): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(host.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }
  return env
}
