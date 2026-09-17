/**
 * The journal: what a process wrote, how it ended, and which pid to aim a signal at — written
 * where an orchestrator that was not running at the time can still read it.
 *
 * The e2b backend journals because e2b forgets a process the moment it exits. A local backend
 * journals for the opposite reason — the machine remembers the process perfectly well, and it
 * is the *orchestrator* that goes away. A desktop app is quit and relaunched far more casually
 * than a worker is evicted, and the contract's `getProcess`/`listProcesses` must answer about
 * a sandbox this process may never have started. In-memory handles cannot; files can.
 *
 * Which is also why the exit code is written by the shell rather than recorded by whoever
 * spawned it. A host-side `'exit'` listener is the obvious implementation and it is wrong in
 * exactly the case this package exists for: quit the app mid-turn and nothing is left to
 * observe the exit, so a turn that finished perfectly comes back as
 * {@link import('@amond-ai/sandbox').SandboxNoExitRecordError}. Everything below runs inside
 * the process tree, so it survives its parent.
 *
 * stdout and stderr are separate files because `ProcessLogEvent` is tagged per stream: the
 * NDJSON a turn writes must not be interleaved with whatever the CLI prints beside it.
 */
import type { SandboxCommand } from '@amond-ai/sandbox'
import { isProcessId, withoutTrailingSlashes } from './paths'
import { quoteArg, quoteArgv, unquoteArgv } from './shell-quote'

/**
 * What every journal script opens with: the shell's no-op builtin, given this wrapper's
 * identity as its one argument.
 *
 * It runs nothing and costs nothing, and it puts that identity in the wrapper's command line
 * where the host's process table will show it. That is what makes a live process identifiable
 * when its record is missing — see {@link parseJournalScript}. A comment would not do: `ps`
 * renders the script verbatim either way, but a `#` would also have to survive being the first
 * thing the shell reads, and `:` is a real command whose behaviour is specified.
 *
 * The identity is two words, `<process id> <nonce>`, and the second one is the whole of the
 * difference between a marker and a claim. A process id and a state directory are both public:
 * anything that can read this package can build a command line carrying them, and recovery
 * hands what it matches to `destroy()`, which signals the process group. The nonce is minted
 * once per sandbox and kept in that sandbox's state directory, so a row counts as ours only
 * when it carries a value this sandbox actually chose.
 */
export const SCRIPT_OPEN = `: '`
const SCRIPT_OPEN_CLOSE = `' ; `

/**
 * What separates the two words of the opener's one argument.
 *
 * A space, which is why {@link isWrapperNonce} refuses one: the boundary between the id and
 * the nonce is found by scanning for the first of these, and a nonce containing another would
 * move it.
 */
const IDENTITY_SEPARATOR = ' '

/**
 * The shell every wrapper runs under.
 *
 * Exported so `node-host.ts` spawns exactly what {@link parseJournalScript} expects to find at
 * the head of a process-table row. The two have to agree: recovery identifies a wrapper by the
 * whole `<shell> -c <marker>` prefix, and a host that spawned a different shell would leave
 * every one of its processes unrecoverable — silently, and only after a crash.
 */
export const WRAPPER_SHELL = '/bin/sh'

/** What a wrapper's process-table row begins with, and nothing else on the machine does. */
const WRAPPER_PREFIX = `${WRAPPER_SHELL} -c ${SCRIPT_OPEN}`

/**
 * The name a sandbox's wrapper nonce is kept under, inside its state directory.
 *
 * A leading dot, so it can never be read as a journal: every journal file is named after a
 * process id, and an id may not contain one (`./paths.ts`). `registry.list()` filters on the
 * `.meta.json` suffix and passes over this either way — the dot is for the human reading a
 * state directory, and for whoever next adds a scan to it.
 */
const NONCE_FILE = '.nonce'

/** Where a sandbox's wrapper nonce lives. Minted by the registry, required by recovery. */
export function noncePath(stateDir: string): string {
  return `${withoutTrailingSlashes(stateDir)}/${NONCE_FILE}`
}

/**
 * What a nonce may be made of.
 *
 * Narrow, because the value is interpolated into a single-quoted shell word and then split
 * back out of one: a `'` would close the quoting and hand the rest of the nonce to the shell as
 * code, and an {@link IDENTITY_SEPARATOR} would move the boundary the parser scans for.
 * Validated at both ends rather than escaped, exactly as an id is — the value is minted by this
 * package, so anything outside this set means it arrived from somewhere it should not have.
 */
const NONCE_PATTERN = /^[\w-]+$/

export function isWrapperNonce(value: string): boolean {
  return NONCE_PATTERN.test(value)
}

/**
 * How long a timed-out command is given to end on its own before it is killed outright.
 *
 * The watchdog asks with SIGTERM first because a command that handles it exits cleanly and
 * flushes what it was writing. A command that ignores it would otherwise run forever with the
 * wrapper still waiting on it — the timeout enforcing nothing at all — so the ask has a
 * deadline of its own.
 */
const TIMEOUT_GRACE_SECONDS = 5

/**
 * What the exit record wears while it is being written, and never once it is readable.
 *
 * Chosen so the state directory's own scan cannot pick one up: `registry.ts` lists records by
 * the `.meta.json` suffix, and nothing else in the package matches on a name.
 */
const PENDING_SUFFIX = '.pending'

export interface JournalPaths {
  stdout: string
  stderr: string
  exit: string
  meta: string
  /**
   * The wrapped command's own pid, written by the wrapper as soon as it knows it.
   *
   * The reason a signal can be aimed at the command rather than at the whole tree. `kill` on
   * this contract must be able to deliver SIGINT *as asked* — the `claude` CLI answers it by
   * ending the turn and printing its `result`, which SIGTERM never yields — and a SIGINT
   * broadcast to the process group would also hit the wrapper shell, which dies on it without
   * running the `printf` that records the exit. The turn would then end with no result and no
   * exit code: both halves of what the interrupt was for, lost.
   */
  pid: string
  /** Written by the wrapper's own watchdog just before it kills a command at its `timeout`. */
  timeout: string
}

/** Where one process's files live, under the sandbox's state directory. */
export function journalPaths(stateDir: string, processId: string): JournalPaths {
  if (!isProcessId(processId)) {
    throw new Error(`invalid process id '${processId}': expected [A-Za-z0-9_-]+`)
  }
  const base = withoutTrailingSlashes(stateDir)
  return {
    stdout: `${base}/${processId}.out`,
    stderr: `${base}/${processId}.err`,
    exit: `${base}/${processId}.exit`,
    meta: `${base}/${processId}.meta.json`,
    pid: `${base}/${processId}.pid`,
    timeout: `${base}/${processId}.timeout`,
  }
}

/**
 * Wrap an argv so its streams, its pid and its exit status land in the journal.
 *
 * The command runs in the background and the wrapper `wait`s on it, rather than running in
 * the wrapper's place. Three things follow from that shape, and each is the reason for it:
 *
 * - `$!` is the command's own pid, because a simple command backgrounded by `&` is forked and
 *   exec'd directly — no subshell in between to be signalled instead of the command;
 * - the wrapper outlives the command by the length of one `printf`, which is what lets the
 *   exit code be recorded by something inside the tree rather than by the orchestrator;
 * - the wrapper is still there to hold a `timeout` watchdog, and the watchdog therefore
 *   survives the orchestrator too — a per-command deadline enforced by a host-side timer would
 *   quietly stop existing the moment the desktop app was quit.
 *
 * `printf '%s'` rather than `echo` keeps the recorded numbers free of a trailing newline the
 * reader would have to strip, and the exit status is handed over by {@link publish} rather
 * than redirected straight at its journal.
 *
 * `nonce` is the sandbox's, not this process's, and it goes in the opener — see
 * {@link SCRIPT_OPEN} for what it is defending and {@link parseJournalScript} for what reads it
 * back. It costs the command line the length of one token: a v4 UUID is 36 bytes against the
 * 256KB `ARG_MAX` that a prompt in the same argv is already the real claimant on.
 *
 * Note what is *not* here: no `setsid`. The e2b backend has to ask for a session of its own
 * because its commands are all started by one daemon inside one session; here the host spawns
 * the shell detached, which is the same syscall without the binary — and `setsid` is not
 * installed on macOS at all, so the local backend gets for free the thing the remote one had
 * to arrange.
 */
export function journalledScript(
  argv: readonly string[],
  paths: JournalPaths,
  nonce: string,
  timeoutMs?: number,
): string {
  // Refused rather than escaped, and refused *here* rather than at the spawn: a nonce carrying
  // a quote would close the opener and run its own tail as shell code, in a script this package
  // composes and hands to `/bin/sh -c` with the orchestrator's whole environment.
  if (!isWrapperNonce(nonce)) {
    throw new Error(`invalid wrapper nonce: expected [A-Za-z0-9_-]+`)
  }
  const id = journalIdOf(paths)
  return [
    `${SCRIPT_OPEN}${id}${IDENTITY_SEPARATOR}${nonce}${SCRIPT_OPEN_CLOSE}${quoteArgv(argv)}${redirection(paths)} & __c=$!`,
    `printf '%s' "$__c" > ${quoteArg(paths.pid, 'the pid journal path')}`,
    ...watchdog(paths, timeoutMs),
    `wait $__c`,
    `__e=$?`,
    ...(timeoutMs === undefined ? [] : [`kill $__w 2> /dev/null`]),
    ...publish('$__e', paths.exit),
    ...reapAfterTimeout(paths, timeoutMs),
  ].join(' ; ')
}

/**
 * Hand the exit status to the journal in a state a reader can only see whole.
 *
 * A plain redirection publishes in two observable steps: `>` truncates the target when the
 * command is set up, and the `printf` fills it some time after. The state in between is a
 * zero-byte file, which the reader already answers as "not written yet", so the plain form is
 * not *wrong* — it is correct by an argument about how a three-byte write behaves rather than
 * by construction. This is the record that settles whether a turn is over, which is not a
 * thing to hold by an argument when POSIX will hold it outright: `rename(2)` within one
 * directory is atomic, so a reader sees no file or the finished status and never a prefix.
 *
 * The pending file is a *sibling* of its target and not somewhere under `TMPDIR`, because `mv`
 * across filesystems is a copy followed by a delete — the non-atomic publication this exists
 * to remove, reintroduced by the fix for it.
 *
 * A wrapper killed between the two commands leaves the pending file and no record, which is
 * the same answer as one killed before either: nothing was published, and the caller reads it
 * as {@link import('@amond-ai/sandbox').SandboxNoExitRecordError} rather than as an exit that
 * never happened.
 *
 * The pid is *not* published this way, and the reason is latency rather than principle. `mv`
 * is a fork and an exec where `printf` is a builtin writing to an fd the shell already holds:
 * measured on macOS 2026-09-13 it moves the pid's arrival from ~8ms after the spawn to ~12ms,
 * which straddles the ~19ms in which `exec()` returns a handle a caller may immediately
 * `kill()` — and a kill that finds no pid is one this backend refuses to deliver rather than
 * broadcast to the group. The exit is read by polling and has no such deadline. What the pid
 * gets instead is what the exit had before: one `printf` of a value the shell already holds,
 * which POSIX makes a single atomic `write()` against any concurrent read of a regular file.
 */
function publish(variable: string, path: string): string[] {
  const pending = quoteArg(`${path}${PENDING_SUFFIX}`, 'the exit journal path')
  // Two things about this `mv` are not incidental. `command -p` resolves it on the system
  // default PATH rather than on the command's own: `LocalSessionOptions.env` exists to be
  // narrowed — its docblock invites exactly that — and an env without a usable PATH would
  // otherwise leave every command in the sandbox unable to publish, so turns that ended fine
  // would all come back as `no_exit_record`. And `--`, because a state root beginning with `-`
  // makes the pending path an option rather than an operand, which quoting does not change:
  // `mv: illegal option -- w` (measured on macOS 2026-09-13).
  return [
    `printf '%s' "${variable}" > ${pending}`,
    `command -p mv -- ${pending} ${quoteArg(path, 'the exit journal path')}`,
  ]
}

/**
 * After a timeout, end what the command left running — and only after a timeout.
 *
 * Signalling the command alone does not bound anything: `sh -c 'sleep 300 & wait'` answers
 * SIGTERM with exit 143 while its child keeps running in the wrapper's group, and this
 * backend's own liveness rule then reports the process as still alive — correctly, since
 * something of it is — so the caller's wait carries on past the deadline it set. The group is
 * the only handle on that remainder.
 *
 * Two details are load-bearing. The exit record is published *before* the signal — the rename
 * included, since a record still under its pending name is one no reader can find — because the
 * group includes the wrapper and the record would otherwise never be written. And the group is
 * named as `-$$` rather than `0`: both mean "my process group" when the wrapper leads one, but
 * a host that neglected to spawn it detached would have `0` name the *orchestrator's* group and
 * kill the application. `-$$` on a wrapper that leads no group names a group that does not
 * exist, which fails harmlessly.
 */
function reapAfterTimeout(paths: JournalPaths, timeoutMs?: number): string[] {
  if (timeoutMs === undefined) {
    return []
  }
  return [`[ -f ${quoteArg(paths.timeout, 'the timeout marker path')} ] && kill -KILL -$$ 2> /dev/null`]
}

/** The redirection both streams take, and the anchor {@link parseJournalScript} matches on. */
function redirection(paths: JournalPaths): string {
  return ` > ${quoteArg(paths.stdout, 'the stdout journal path')} 2> ${quoteArg(paths.stderr, 'the stderr journal path')}`
}

/**
 * The per-command deadline, enforced from inside the tree.
 *
 * `kill -0` first, so a command that finished on time is not marked as timed out by a watchdog
 * that woke a moment later. The marker is written *before* the signal, because the reader can
 * only ever see the file after the fact and the other order leaves a window where a killed
 * command reads as one that failed on its own.
 *
 * It is redirected straight at its path rather than published through {@link publish}, and the
 * difference is that nobody reads its contents — `[ -f ]` below, `exists()` in the reader — so
 * the whole record is the file's existence, which the redirection establishes in one step. The
 * `t` is there to make the file legible to a human looking at a state directory.
 */
function watchdog(paths: JournalPaths, timeoutMs?: number): string[] {
  if (timeoutMs === undefined) {
    return []
  }
  const seconds = Math.max(0, timeoutMs) / 1000
  return [
    `{ sleep ${seconds} ; kill -0 $__c 2> /dev/null`
    + ` && { printf t > ${quoteArg(paths.timeout, 'the timeout marker path')} ; kill -TERM $__c 2> /dev/null`
    + ` ; sleep ${TIMEOUT_GRACE_SECONDS} ; kill -KILL $__c 2> /dev/null ; } ; } & __w=$!`,
  ]
}

/** The id back out of a path set, so the script does not have to be handed it twice. */
function journalIdOf(paths: JournalPaths): string {
  const slash = paths.exit.lastIndexOf('/')
  return paths.exit.slice(slash + 1, -'.exit'.length)
}

/** What a journal script says about itself when its record is gone. */
export interface RecoveredScript {
  id: string
  command: SandboxCommand
}

/**
 * Read a wrapper's command line back into the process it is running.
 *
 * The path recovery takes. A record is written after the spawn — the pid is not known before
 * it — and on a backend with no filesystem boundary the command can also delete its own; in
 * both cases the process is live and unnamed, while the host's process table still carries the
 * script verbatim. Answering `undefined` for anything that is not one of ours is the point:
 * the table holds every process on the machine.
 *
 * The id is read from the opener and everything else is then *derived* from it rather than
 * scanned for. That is what keeps attacker-influenced text out of the decision: a prompt
 * carries an issue body, an issue body can quote any marker this module emits, and the check
 * that survives that is "the redirection targets the files this state directory would give
 * that id" — a string the wrapper cannot be talked into containing unless it really is ours.
 *
 * Deriving is not the same as authenticating, which is what `nonce` is here for. Everything
 * derived above is *public*: the shell, the opener, the id and the state directory are all
 * readable from this package or from a `ps`, so any process on the machine can run a command
 * line that reproduces them exactly — and the row that matches is handed to `destroy()`, which
 * signals its process group. Requiring a value minted per sandbox and kept in that sandbox's
 * own state directory is what turns the match from a shape into a claim.
 *
 * It is a claim against *coincidence and accident*, and deliberately not more than that. The
 * nonce is in the wrapper's command line, so it is legible to anything on the machine that can
 * run `ps` — a local attacker reads it and reproduces it. That is the same bar the rest of this
 * package holds: a command here runs unconfined with the orchestrator's environment, and the
 * README says the name says sandbox and the backend is not one. What this closes is the case
 * where something that is *not* trying reproduces the marker anyway, which is the case that was
 * actually reachable.
 *
 * **The argv it hands back is the process table's rendering, not the bytes that were passed.**
 * Measured on macOS 2026-09-13: `ps` escapes a newline in an argument as the four characters
 * `\012` and a tab as `\011`, and Linux sanitises too, so a recovered multi-line prompt is not
 * byte-identical to the one that was spawned. That is a real limit of recovering from the table
 * and it is not worth encoding around — carrying an encoded copy of the argv in the wrapper's
 * own command line would double a prompt that is already the largest thing in it, against an
 * `ARG_MAX` of 256KB on macOS. It costs nothing in the ordinary case, because a process that
 * still has its record is read from the record: this path is reached only for one whose record
 * was never written or was deleted. The escaping does mean a wrapper's row never spans two
 * lines, which is what makes the table parseable line by line at all.
 */
export function parseJournalScript(
  line: string,
  stateDir: string,
  nonce: string | undefined,
): RecoveredScript | undefined {
  // A sandbox with no readable nonce claims nothing at all. The file is written before this
  // sandbox's first wrapper is spawned and removed only along with the state directory, so its
  // absence means either that nothing was ever started here — in which case there is nothing to
  // find — or that the bookkeeping has been interfered with, in which case there is no longer
  // anything that tells one of our wrappers from a reproduction of one. Recovering nothing
  // costs an orphan that could once have been killed; recovering on the public part of the
  // marker alone kills whatever reproduces it.
  if (nonce === undefined) {
    return undefined
  }
  // Anchored at the start of the row, not searched for anywhere in it. A marker *found* in a
  // command line says only that some process has this text among its arguments — an editor
  // holding the file open, a `grep` for it, or the turn's own `claude` carrying it inside a
  // prompt. Recovery hands what it finds to `destroy()`, which signals the process group, so
  // matching a stranger is not a wrong label but a killed bystander.
  if (!line.startsWith(WRAPPER_PREFIX)) {
    return undefined
  }
  const from = WRAPPER_PREFIX.length
  const idEnd = line.indexOf(SCRIPT_OPEN_CLOSE, from)
  if (idEnd < 0) {
    return undefined
  }
  // The opener's one argument is `<id> <nonce>`, split at the first separator rather than the
  // last: an id cannot contain one, so the first is the boundary, and everything after it has
  // to equal the nonce whole — a row carrying a longer value that merely starts with ours is
  // not ours.
  const identity = line.slice(from, idEnd)
  const split = identity.indexOf(IDENTITY_SEPARATOR)
  if (split < 0) {
    return undefined
  }
  const id = identity.slice(0, split)
  if (!isProcessId(id) || identity.slice(split + IDENTITY_SEPARATOR.length) !== nonce) {
    return undefined
  }
  const argvFrom = idEnd + SCRIPT_OPEN_CLOSE.length
  const argvTo = line.lastIndexOf(`${redirection(journalPaths(stateDir, id))} & __c=$!`)
  if (argvTo < argvFrom) {
    return undefined
  }
  const command = unquoteArgv(line.slice(argvFrom, argvTo))
  return command ? { id, command: command as unknown as SandboxCommand } : undefined
}

/** What the backend must remember about a process once nothing is holding its handle. */
export interface ProcessRecord {
  id: string
  /** The wrapper shell's pid, which is also its process-group id. */
  pid: number
  /** Non-empty by construction: a record naming no command records nothing that ran. */
  command: SandboxCommand
  /** The working directory as resolved on the host, absolute. */
  cwd?: string
  /** When this backend started it, ISO-8601. Reported to callers. */
  startedAt: string
  /**
   * The kernel's start time for {@link pid}, verbatim from the host's process table.
   *
   * The whole reason a record is not enough on its own. Pids are reused, and a record that
   * says only "pid 4711" cannot tell a turn still running from an unrelated process that
   * inherited the number after a reboot — an answer of "running" there is a turn the
   * orchestrator will not restart and a checkout nothing is writing to. Optional because the
   * host may not have been able to answer at spawn time, which is treated as "cannot tell"
   * rather than as agreement.
   */
  kernelStartedAt?: string
}

export function serializeProcessRecord(record: ProcessRecord): string {
  return JSON.stringify(record)
}

/**
 * Read a record back, or `undefined` when the file is absent, truncated, or not one.
 *
 * A missing record is a normal state — the process may never have started — so absence is
 * reported rather than thrown, and the caller decides what it means.
 */
export function parseProcessRecord(raw: string): ProcessRecord | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const candidate = parsed as Partial<ProcessRecord>
  // Every field is checked, not just the shape. A record lives on a filesystem the command
  // itself can write to, so `["claude", 5]` must not pass the cast and violate the tuple's own
  // invariant downstream — and neither must an `id` that no journal path can be built from,
  // which `registry.list()` would carry to a `journalPaths()` call that throws for the whole
  // sandbox rather than for the one malformed file. `isSafeInteger` rather than `isInteger`
  // for the pid, because `1e100` is an integer to JavaScript and not a number any host will
  // accept as a pid: the record would survive parsing and fail at the liveness probe instead.
  if (typeof candidate.id !== 'string' || !isProcessId(candidate.id)
    || typeof candidate.pid !== 'number'
    || !Number.isSafeInteger(candidate.pid) || candidate.pid <= 0
    || !Array.isArray(candidate.command) || candidate.command.length === 0
    || !candidate.command.every(element => typeof element === 'string')
    || typeof candidate.startedAt !== 'string') {
    return undefined
  }
  return candidate as ProcessRecord
}
