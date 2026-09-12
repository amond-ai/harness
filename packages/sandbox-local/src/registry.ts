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
import type { LocalHost, LocalProcessRow } from './local-surface'
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
   * that had already emptied out. It refuses an *unverified* leader for the same reason.
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
  /**
   * Per process id: that the pid was *not* ours when last asked, and when that was.
   *
   * Only the negative answer, and that asymmetry is the whole content of this cache. While a
   * pid stays allocated, "not ours" cannot become "ours" — a process this record was written
   * for does not come back on a pid it has already lost — so a stale negative is still true.
   * A positive goes the other way: our process exits, the kernel hands the number to a
   * stranger, and `signal(pid, 0)` keeps answering yes throughout. Reusing a cached `'live'`
   * across that would report the stranger as our process and, through `kill`, signal it.
   *
   * So a positive costs a process-table read every time it is asked for. There is no cheaper
   * reuse detector to cache against: the pid alone cannot tell the two apart, which is the
   * premise of `ownsPid` above it.
   */
  const notOurs = new Map<string, number>()

  /**
   * Is the process now holding this pid the one the record was written for?
   *
   * `undefined` means the host did not say enough to tell, which the caller reports as
   * `'unknown'` rather than resolving either way.
   *
   * The wrapper's own marker settles it wherever it can be read, and the start time is the
   * fallback rather than the rule. That ordering is what the times cannot give on their own:
   * `ps -o lstart` resolves to one second on both supported platforms (measured 2026-09-13 —
   * two processes started in the same second report an identical string), so a pid recycled
   * inside that second compares equal and a stranger reads as ours. The command line does not
   * have that problem, and there is no portable finer clock to reach for instead: Linux has
   * `/proc/<pid>/stat` start ticks and macOS has no `/proc` at all.
   *
   * An unreadable command line falls back to the time rather than to a verdict. A row whose
   * argv the host truncated is not evidence of a stranger, and answering `'gone'` for one would
   * declare a live turn dead — the asymmetric mistake this whole file is built to avoid.
   */
  function ownsPid(record: ProcessRecord, row: LocalProcessRow): boolean | undefined {
    const wrapper = parseJournalScript(row.command, stateDir)
    if (wrapper !== undefined) {
      return wrapper.id === record.id
    }
    if (row.command !== '' && record.kernelStartedAt === undefined) {
      // Someone else's process, holding a pid this record was never able to pin down.
      return false
    }
    return record.kernelStartedAt === undefined ? undefined : row.startedAt === record.kernelStartedAt
  }

  async function liveness(record: ProcessRecord): Promise<Liveness> {
    if (!isSignalablePid(record.pid)) {
      return 'gone'
    }
    if (!host.signal(record.pid, 0)) {
      // The pid is free. Nothing else can be true of it, and the cached identity is now about
      // a number rather than about a process, so it goes.
      notOurs.delete(record.id)
      return 'gone'
    }
    const ruledOut = notOurs.get(record.id)
    if (ruledOut !== undefined && elapsedMs() - ruledOut < identityTtlMs) {
      return 'gone'
    }
    const row = await host.identify(record.pid)
    if (row === undefined) {
      // Nothing to compare against, so nothing can be ruled out. Reported as unknown rather
      // than as agreement: the callers read `'gone'` as a confirmed death and everything else
      // as possibly-running, and the two mistakes are not symmetric — a live turn misjudged
      // dead becomes a second `claude` in the same checkout.
      return 'unknown'
    }
    const ours = ownsPid(record, row)
    if (ours === undefined) {
      return 'unknown'
    }
    if (ours) {
      // Deliberately not remembered: see `notOurs`. This answer is true of the process holding
      // the pid *now*, and the next caller has no way to know the kernel has not reissued it.
      notOurs.delete(record.id)
      return 'live'
    }
    notOurs.set(record.id, elapsedMs())
    return 'gone'
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
        if (data.length === 0) {
          return undefined
        }
        const record = parseProcessRecord(new TextDecoder().decode(data))
        // The same filename check `read` makes, and for a sharper reason here: `destroy()`
        // signals every group this list names, so a record whose `id` disagrees with the file
        // it was read from would let one writable journal file aim that kill at another
        // process's group. Answered as absence, exactly as a single read answers it.
        return record?.id === id ? record : undefined
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
      const state = await liveness(record)
      // An unverified leader is not a licence to signal its group. A group id *is* a leader's
      // pid, so when the host cannot say whether that pid is still ours, `-pid` may name a
      // stranger's group — and this call is the one that ends processes. Declining costs an
      // unconfirmed kill, which the contract already describes: the caller's bounded wait times
      // out and escalates. Signalling costs someone else's work.
      if (state === 'unknown') {
        return false
      }
      if (state === 'gone' && host.signal(record.pid, 0)) {
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
