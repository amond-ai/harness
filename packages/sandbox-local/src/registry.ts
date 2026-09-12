/**
 * The durable process registry — the part a local backend cannot borrow from anyone.
 *
 * The contract says `getProcess`/`listProcesses` answer about a sandbox the caller may never
 * have started, and on a desktop app that is the ordinary case rather than the edge one: quit
 * the app during a turn, relaunch it, and the only thing that still knows a `claude` is
 * running in that checkout is the disk. So a record per process, and — the part that is easy
 * to leave out and expensive to leave out — **liveness is verified, never inferred from the
 * record**. A pid is a number the kernel reuses. A registry that answers "running" because it
 * once wrote down 4711 will, after a reboot, report someone else's `Dock` as the turn in
 * progress, and the orchestrator will decline to restart a turn that is not there.
 *
 * What makes the answer trustworthy is the pair: the pid, and the kernel's own start time for
 * it. Neither is enough alone — the pid says which process to ask about, the start time says
 * whether the process answering is the one we asked about — and the pair is compared rather
 * than parsed, so this file never has to agree with `ps` about a date format.
 *
 * The second question this file answers is narrower and just as load-bearing: has *anything*
 * from the tree outlived the wrapper? A command that detaches a child and exits leaves that
 * child writing to the checkout, and a caller told "finished" starts a second one beside it.
 * The wrapper is spawned as its own process-group leader precisely so the question has a cheap
 * answer — signalling `-pid` reaches every member of the group — and {@link ProcessRegistry.survivors}
 * is where the group id's own reuse hazard is reasoned about.
 */
import type { ProcessRecord } from './journal'
import type { LocalHost } from './local-surface'
import { journalPaths, parseJournalScript, parseProcessRecord, serializeProcessRecord } from './journal'
import { isProcessId } from './paths'

const RECORD_SUFFIX = '.meta.json'

/**
 * Whether a recorded pid names something a signal may be aimed at.
 *
 * `0` and negatives are not merely useless here, they are dangerous: POSIX reads `kill(0, sig)`
 * as "every process in the caller's own group", so a record carrying `0` — the placeholder for
 * a process known only by the files it left behind — would answer a liveness probe with the
 * orchestrator's own liveness, and a group kill would aim at the orchestrator itself.
 */
function isSignalablePid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 0
}

/** What can be said about the process a record names, from the host's process table. */
export type Liveness
  /** The pid is running and it is the process the record was written for. */
  = | 'live'
  /** The pid is free, or belongs to something that started at a different time. */
    | 'gone'
  /** The pid is running and the host could not say when it started. */
    | 'unknown'

export interface ProcessRegistry {
  /** Create the state directory, verified rather than assumed. */
  ensure: () => Promise<void>
  remember: (record: ProcessRecord) => Promise<void>
  read: (id: string) => Promise<ProcessRecord | undefined>
  /** Every process this sandbox has a record for, plus every live one it has lost the record of. */
  list: () => Promise<ProcessRecord[]>
  /** Live wrappers found by reading the host's process table, keyed by process id. */
  recovered: () => Promise<Map<string, ProcessRecord>>
  liveness: (record: ProcessRecord) => Promise<Liveness>
  /** Whether anything from the wrapper's process group is still running. */
  survivors: (record: ProcessRecord) => Promise<'some' | 'none'>
  /**
   * Deliver a signal to the whole process group — the last resort, not the ordinary path.
   *
   * `false` when there was nothing of ours to signal, *including* the case where the leader's
   * pid now belongs to someone else: a group id is a leader's pid, so signalling `-pid` after
   * that number has been reissued would reach a stranger's process group. Refusing is the only
   * safe answer, and it costs nothing real — a group that could be confused this way is one
   * that had already emptied out.
   */
  signalGroup: (record: ProcessRecord, signal: number) => Promise<boolean>
}

export interface ProcessRegistryOptions {
  host: LocalHost
  /** This sandbox's state directory — where the records and journals live. */
  stateDir: string
  now: () => string
  /** Monotonic milliseconds, for {@link ProcessRegistryOptions.identityTtlMs}. */
  elapsedMs?: () => number
  /** How long an identity check is reused before the host is asked again. */
  identityTtlMs?: number
}

/**
 * How long the "this pid is still ours" answer is cached.
 *
 * Asking the host costs a process-table read, and the loops that ask — a following `logs()`,
 * an unbounded `waitForExit()` — ask several times a second for as long as a turn runs. What
 * makes caching safe at all is that the *cheap* half of the check is not cached: a pid whose
 * `signal(pid, 0)` starts failing drops its entry immediately, and a pid cannot be recycled
 * without passing through that state. So the only exposure is a process that exits and has
 * its number reissued entirely inside one window, on a kernel that allocates pids
 * sequentially across the whole range. Five seconds is short against that and long against
 * the poll cadence, which is the trade being made.
 */
const DEFAULT_IDENTITY_TTL_MS = 5_000

export function createProcessRegistry(options: ProcessRegistryOptions): ProcessRegistry {
  const { host, now, stateDir } = options
  const elapsedMs = options.elapsedMs ?? (() => Date.now())
  const identityTtlMs = options.identityTtlMs ?? DEFAULT_IDENTITY_TTL_MS
  /** Per process id: whether the pid was ours when last asked, and when that was. */
  const identity = new Map<string, { ours: boolean, at: number }>()

  async function liveness(record: ProcessRecord): Promise<Liveness> {
    if (!isSignalablePid(record.pid)) {
      return 'gone'
    }
    if (!host.signal(record.pid, 0)) {
      // The pid is free. Nothing else can be true of it, and the cached identity is now about
      // a number rather than about a process, so it goes.
      identity.delete(record.id)
      return 'gone'
    }
    if (record.kernelStartedAt === undefined) {
      // Nothing to compare against, so nothing can be ruled out. Reported as unknown rather
      // than as agreement: the callers read `'gone'` as a confirmed death and everything else
      // as possibly-running, and the two mistakes are not symmetric — a live turn misjudged
      // dead becomes a second `claude` in the same checkout.
      return 'unknown'
    }
    const cached = identity.get(record.id)
    if (cached && elapsedMs() - cached.at < identityTtlMs) {
      return cached.ours ? 'live' : 'gone'
    }
    const startedAt = await host.startedAt(record.pid)
    if (startedAt === undefined) {
      return 'unknown'
    }
    const ours = startedAt === record.kernelStartedAt
    identity.set(record.id, { ours, at: elapsedMs() })
    return ours ? 'live' : 'gone'
  }

  return {
    liveness,

    ensure: async () => {
      await host.mkdir(stateDir)
      if (!await host.exists(stateDir)) {
        throw new Error(`sandbox state directory '${stateDir}' does not exist and could not be created`)
      }
    },

    remember: async (record: ProcessRecord) => {
      await host.writeFile(
        journalPaths(stateDir, record.id).meta,
        new TextEncoder().encode(serializeProcessRecord(record)),
      )
    },

    read: async (id: string) => {
      if (!isProcessId(id)) {
        return undefined
      }
      const { data } = await host.readSlice(journalPaths(stateDir, id).meta, 0)
      if (data.length === 0) {
        return undefined
      }
      const record = parseProcessRecord(new TextDecoder().decode(data))
      // An id that does not match the file it was read from is a record for another process,
      // however it got there. Answered as absence, which is what the caller can act on.
      return record?.id === id ? record : undefined
    },

    recovered: async () => recoveredIn(host, stateDir, now),

    list: async () => {
      const names = await host.readdir(stateDir)
      const ids = names
        .filter(name => name.endsWith(RECORD_SUFFIX))
        .map(name => name.slice(0, -RECORD_SUFFIX.length))
        .filter(isProcessId)
      const stored = await Promise.all(ids.map(async (id) => {
        const { data } = await host.readSlice(journalPaths(stateDir, id).meta, 0)
        return data.length === 0 ? undefined : parseProcessRecord(new TextDecoder().decode(data))
      }))
      // The records name what has *run*; the process table names what is *running*. Unioned
      // because neither is complete on its own: an exited process is only in the records, and
      // one whose record was never written — or was deleted — is only in the table, and that
      // second gap is the one a duplicate-turn guard would meet as "nothing is running here".
      const byId = await recoveredIn(host, stateDir, now)
      for (const record of stored) {
        if (record) {
          byId.set(record.id, record)
        }
      }
      return [...byId.values()]
    },

    survivors: async (record: ProcessRecord) => {
      const leader = await liveness(record)
      if (leader !== 'gone') {
        return 'some'
      }
      // The leader is gone. Whether the group id still means anything turns on why:
      //
      // - the pid is *free*, so nothing can have taken the group id — a group's id stays
      //   reserved while any member holds it. So an answer from `-pid` is our own orphan;
      // - the pid is *taken* by something that started at another time, which can only have
      //   happened after our group emptied out. `-pid` now names a stranger's group, and the
      //   honest answer about ours is that it is empty.
      if (!isSignalablePid(record.pid) || host.signal(record.pid, 0)) {
        return 'none'
      }
      return host.signal(-record.pid, 0) ? 'some' : 'none'
    },

    signalGroup: async (record: ProcessRecord, signal: number) => {
      if (!isSignalablePid(record.pid)) {
        return false
      }
      if (await liveness(record) === 'gone' && host.signal(record.pid, 0)) {
        return false
      }
      return host.signal(-record.pid, signal)
    },
  }
}

/**
 * Live wrappers read out of the host's process table.
 *
 * `startedAt` is when the wrapper was *found*, not when it started: the table reports the
 * kernel's clock in the kernel's format, and the contract asks for an ISO timestamp. The
 * kernel's own answer is kept as {@link ProcessRecord.kernelStartedAt}, where it is compared
 * rather than displayed.
 */
async function recoveredIn(
  host: LocalHost,
  stateDir: string,
  now: () => string,
): Promise<Map<string, ProcessRecord>> {
  const found = new Map<string, ProcessRecord>()
  for (const row of await host.processes()) {
    const script = parseJournalScript(row.command, stateDir)
    if (script) {
      found.set(script.id, {
        id: script.id,
        pid: row.pid,
        command: script.command,
        startedAt: now(),
        kernelStartedAt: row.startedAt,
      })
    }
  }
  return found
}
