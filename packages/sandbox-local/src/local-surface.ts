/**
 * The host primitives this backend runs on, as a structural interface.
 *
 * Every other module in the package is written against this and imports no `node:` builtin,
 * for the reason `closure.test.ts` states about the set as a whole: these packages have to
 * run wherever the orchestrator does, and a local backend is the one member whose subject
 * *is* the machine. Confining that to a single implementation module keeps the rest —
 * the journal, the registry, the log reads, the session — exercisable against a fake, which
 * matters more here than anywhere else in the set: the behaviour worth testing is what
 * happens when a pid is reused, when a wrapper dies without recording an exit, and when a
 * second orchestrator starts over a sandbox the first one left behind, none of which a test
 * can arrange against a real process table without racing it.
 *
 * `./node-host.ts` binds the real builtins to it, and is the only file in the package that
 * names them.
 */

/** Bytes read from a file, and how long that file was when they were read. */
export interface LocalSlice {
  data: Uint8Array
  /**
   * The file's full length at read time — never `data.length`.
   *
   * A follower's cursor is a position in the file, so it must advance by what the file holds
   * rather than by what this read served; the two differ whenever a `length` was asked for.
   */
  total: number
}

/** One row of the host's process table. */
export interface LocalProcessRow {
  pid: number
  /**
   * The kernel's start time for this pid, as the host reports it verbatim.
   *
   * Never parsed, only compared: what makes it useful is that a *reused* pid reports a
   * different one, and equality answers that without this package having to agree with `ps`
   * about a date format that differs by platform and locale.
   */
  startedAt: string
  /** The process's command line, joined the way the host's process table renders it. */
  command: string
}

export interface LocalSpawnSpec {
  /** A POSIX shell script — {@link import('./journal').journalledScript} builds it. */
  script: string
  cwd: string
  env: Record<string, string>
}

export interface LocalSpawned {
  /**
   * The pid of the shell running the script, which is also its process-group id.
   *
   * A host must start the script detached — its own session, so it survives the orchestrator
   * and so `signal(-pid)` reaches the whole tree the command spawns rather than only the
   * shell.
   */
  pid: number
}

export interface LocalHost {
  /** The environment a spawned command inherits before {@link LocalSpawnSpec.env} is layered on. */
  readonly env: Readonly<Record<string, string | undefined>>
  /** The file's size, or `undefined` when there is no file. Never throws for absence. */
  size: (path: string) => Promise<number | undefined>
  /** Whether anything — file, directory, socket — exists at `path`. */
  exists: (path: string) => Promise<boolean>
  /**
   * Bytes from `offset`, at most `length` of them, plus the file's size.
   *
   * An absent file reads as empty rather than throwing: a journal is created by the wrapper's
   * first write, so "the process has produced no stderr yet" and "there is no such process"
   * arrive here identically and only the caller can tell them apart.
   */
  readSlice: (path: string, offset: number, length?: number) => Promise<LocalSlice>
  writeFile: (path: string, data: Uint8Array) => Promise<void>
  /** Create the directory and every parent. Succeeds when it is already there. */
  mkdir: (path: string) => Promise<void>
  /** Entry names, or `[]` when the directory does not exist. */
  readdir: (path: string) => Promise<string[]>
  /** Remove a path and everything under it. Succeeds when it is already gone. */
  remove: (path: string) => Promise<void>
  spawn: (spec: LocalSpawnSpec) => Promise<LocalSpawned>
  /**
   * Deliver `signal` to a pid, or to the whole process group when `pid` is negative.
   *
   * `false` means "no such process" — the one answer this backend reads as a fact rather than
   * as a failure. Signal `0` delivers nothing and is how liveness is asked, including of a
   * group: a group answers while *any* member of it is alive, which is what tells a wrapper
   * that has exited apart from a child it detached and left running.
   */
  signal: (pid: number, signal: number) => boolean
  /** The kernel's start time for one pid, or `undefined` when it is gone or unreadable. */
  startedAt: (pid: number) => Promise<string | undefined>
  /** The host's whole process table. Read only by recovery, which has no pid to ask about. */
  processes: () => Promise<LocalProcessRow[]>
}
