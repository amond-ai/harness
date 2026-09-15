/**
 * The process journal — what Vercel forgets, written down.
 *
 * Vercel remembers a *command*: `getCommand(cmdId)` resolves one, `logs()` replays its output,
 * and `wait()` resolves its exit. What it does not remember is that across a session boundary.
 * A sandbox's session is the running VM, and a sandbox that timed out, was stopped, or was
 * resumed from a snapshot has a new one — while the contract's `getProcess`/`listProcesses`
 * must answer about a turn a *previous* orchestrator started, and `replayTurn` reads a
 * transcript only once the turn has ended. There is also no process listing at all: nothing in
 * the SDK answers "what is running in this sandbox", which is the question the duplicate-turn
 * guard is made of.
 *
 * So the wrapper writes it down. Eight files per process on the sandbox filesystem, read back
 * through the contract's `logs()`/`status()`/`waitForExit()`, and the exit code among them is
 * written *by the shell inside the sandbox* rather than recorded by whoever spawned it — the
 * orchestrator is a workflow step that may be evicted mid-turn, and a turn that finished
 * perfectly must not come back as {@link import('@amond-ai/sandbox').SandboxNoExitRecordError}
 * because nothing was left watching.
 *
 * stdout and stderr are separate files rather than one interleaved stream because
 * `ProcessLogEvent` is tagged per stream and `demuxProcessEvents` splits on that tag: the NDJSON
 * a turn writes must not be polluted by whatever the CLI prints beside it.
 */
import type { SandboxCommand } from '@amond-ai/sandbox'
import { quoteArg, quoteArgv, unquoteArgv } from './shell-quote'

/**
 * What every journal script opens with: the shell's no-op builtin, given the process id as its
 * one argument.
 *
 * It runs nothing and costs nothing, and it puts the id at offset 0 of the script — which is
 * the argument the wrapper's `/proc/<pid>/cmdline` carries, and the only place a live process
 * names itself when its meta file is missing or was deleted by the turn itself. A comment would
 * not do: the id has to survive being the first thing the shell reads, and `:` is a real command
 * whose behaviour is specified.
 */
export const SCRIPT_OPEN = `: '`
const SCRIPT_OPEN_CLOSE = `' ; `

/**
 * The shell every wrapper runs under.
 *
 * Exported so the session spawns exactly what {@link parseJournalScript} expects to find at the
 * head of a rendered command line. The two have to agree: recovery identifies a wrapper by the
 * whole `<shell> -c <marker>` prefix, and a session that spawned a different shell would leave
 * every one of its processes unrecoverable — silently, and only after an eviction.
 */
export const WRAPPER_SHELL = 'sh'

/** What a wrapper's rendered command line begins with, and nothing else in the sandbox does. */
const WRAPPER_PREFIX = `${WRAPPER_SHELL} -c ${SCRIPT_OPEN}`

/**
 * The exact prefix one process's wrapper command line carries, and no other process's does.
 *
 * Exported so the liveness probe can ask the question {@link parseJournalScript} asks — "is the
 * process at this pid still *our* wrapper" — without reimplementing the marker and drifting from
 * it. Pids are recycled, and a probe that answered "live" for a stranger that inherited the
 * number would report a finished turn as running and, worse, aim a kill at an innocent process.
 * Anchored matching against this string is what makes that impossible rather than unlikely.
 */
export function wrapperMarker(processId: string): string {
  if (!isProcessId(processId)) {
    throw new Error(`invalid process id '${processId}': expected [A-Za-z0-9_-]+`)
  }
  return `${WRAPPER_PREFIX}${processId}${SCRIPT_OPEN_CLOSE}`
}

/** What {@link journalledScript} brackets the argv with, so it can be read back out. */
const ARGV_OPEN = '{ '
const ARGV_CLOSE = ' ; }'

/**
 * How long a timed-out command is given to end on its own before it is killed outright.
 *
 * The watchdog asks with SIGTERM first because a command that handles it exits cleanly and
 * flushes what it was writing. A command that ignores it would otherwise run forever with the
 * wrapper still waiting on it — the timeout enforcing nothing at all — so the ask has a deadline
 * of its own.
 */
const TIMEOUT_GRACE_SECONDS = 5

/** What the exit record wears while it is being written, and never once it is readable. */
const PENDING_SUFFIX = '.pending'

export interface JournalPaths {
  out: string
  err: string
  exit: string
  /** Where the exit status is written before it is renamed onto {@link exit}. */
  exitPending: string
  /**
   * The wrapped command's own pid, written by the wrapper as soon as it knows it.
   *
   * The reason a signal can be aimed at the command rather than at the whole group. `kill` on
   * this contract must be able to deliver SIGINT *as asked* — the `claude` CLI answers it by
   * ending the turn and printing its `result`, which SIGTERM never yields — and a SIGINT
   * broadcast to the group would also hit the wrapper shell, which dies on it without running
   * the `printf` that records the exit. The turn would then end with no result and no exit
   * code: both halves of what the interrupt was for, lost.
   */
  pid: string
  /** The wrapper's own pid, which under `setsid` is also the turn's process-group id. */
  pgid: string
  /** Written by the wrapper's own watchdog just before it kills a command at its `timeout`. */
  timeout: string
  meta: string
}

/**
 * Where one process's artefacts live.
 *
 * The id is validated rather than escaped: it is interpolated into a filesystem path, and the
 * ids this backend mints are opaque tokens, so anything outside `[A-Za-z0-9_-]` means a caller
 * passed something it should not have — including the `../` that would write outside the
 * journal root.
 */
export function journalPaths(root: string, processId: string): JournalPaths {
  if (!isProcessId(processId)) {
    throw new Error(`invalid process id '${processId}': expected [A-Za-z0-9_-]+`)
  }
  const base = withoutTrailingSlashes(root)
  const exit = `${base}/${processId}.exit`
  return {
    out: `${base}/${processId}.out`,
    err: `${base}/${processId}.err`,
    exit,
    exitPending: `${exit}${PENDING_SUFFIX}`,
    pid: `${base}/${processId}.pid`,
    pgid: `${base}/${processId}.pgid`,
    timeout: `${base}/${processId}.timeout`,
    meta: `${base}/${processId}.meta.json`,
  }
}

/**
 * Does this string name a process the way {@link journalPaths} demands?
 *
 * Exported so `listProcesses` can *skip* a filename it would reject rather than let
 * {@link journalPaths} throw mid-listing: the journal root is an ordinary directory, and one
 * unrelated file dropped in it would otherwise take out process discovery for that sandbox
 * entirely — inside a never-retried workflow step.
 */
export function isProcessId(value: string): boolean {
  return /^[\w-]+$/.test(value)
}

/**
 * Every trailing separator removed — `/` included, so an all-separator root becomes empty and
 * the join below does not double the leading separator.
 *
 * A scan rather than `replace(/\/+$/, '')`, and not as a matter of taste: that pattern gives the
 * engine no position to anchor at, so it retries at every index and backtracks the whole run of
 * separators at each one — quadratic in the length of a path that is mostly `/`, which CodeQL
 * reports as a polynomial regular expression on uncontrolled data. The root arrives through an
 * exported function, so its length is the caller's to choose.
 */
function withoutTrailingSlashes(path: string): string {
  let end = path.length
  while (end > 0 && path[end - 1] === '/') {
    end--
  }
  return path.slice(0, end)
}

/**
 * Trailing separators removed, keeping the root itself a root.
 *
 * The one difference from {@link withoutTrailingSlashes}, and the reason both exist: a path of
 * nothing but separators is the filesystem root, and returning `''` for it would turn every path
 * joined onto it into a relative one. {@link journalPaths} can strip the same separator and still
 * be right because it rebuilds its paths as `${base}/${id}`, where the literal separator survives
 * an empty base; a caller that hands the root to a shell as one argument has no such literal, so
 * `mkdir -p -- ''` is what an unkept root becomes.
 *
 * Exported for that caller — see `createVercelSession`, which normalizes its `journalRoot` once
 * and passes it to `createJournalIo`.
 */
export function trimTrailingSlash(path: string): string {
  const trimmed = withoutTrailingSlashes(path)
  // `/` trims to the empty string, which would then join as a relative path.
  return trimmed === '' ? path.slice(0, 1) : trimmed
}

/**
 * Wrap an argv so its streams, its pids and its exit status land in the journal.
 *
 * The whole script is run as `setsid --wait sh -c '<script>'`, which the session builds. Two
 * halves of that are load-bearing. `setsid` is for the process *group*: a turn spawns `git`,
 * `bun` and language servers, and one default kill has to reach all of them rather than the
 * shell alone. `--wait` because a bare forked `setsid` exits immediately, and a backend
 * tracking a parent that is already gone reports every turn as finished the moment it started —
 * the failure the e2b backend measured before it stopped being possible there.
 *
 * Inside it, the command runs in the background and the wrapper `wait`s on it rather than
 * running in its place. That is Daytona's `exec` shape inverted, and deliberately: this wrapper
 * needs `$?`, and backgrounding is what makes the recorded pid the command's own. A simple
 * command backgrounded by `&` is forked and exec'd directly — no subshell in between — so a
 * named signal aimed at `<id>.pid` reaches `claude` and not a wrapper shell that would die on
 * SIGINT before recording the exit.
 *
 * `printf '%s'` rather than `echo` keeps the recorded numbers free of a trailing newline the
 * reader would have to strip, and the exit status is handed over by {@link publish} rather than
 * redirected straight at its journal.
 *
 * Note what is *not* here: no `cd` and no `env` splicing. `RunCommandParams` carries `cwd` and
 * `env` natively, so the Daytona backend's prologue has no counterpart — the fewer things the
 * script says, the fewer there are for a prompt to be mistaken for.
 */
export function journalledScript(
  argv: readonly string[],
  paths: JournalPaths,
  timeoutMs?: number,
): string {
  return [
    `${SCRIPT_OPEN}${journalIdOf(paths)}${SCRIPT_OPEN_CLOSE}${pgidRecord(paths)}`
    + ` ; ${ARGV_OPEN}${quoteArgv(argv)}${ARGV_CLOSE}${redirection(paths)} & __c=$!`,
    `printf '%s' "$__c" > ${quoteArg(paths.pid)}`,
    ...watchdog(paths, timeoutMs),
    `wait $__c`,
    `__e=$?`,
    ...(timeoutMs === undefined ? [] : [`kill $__w 2> /dev/null`]),
    ...publish('$__e', paths),
    ...reapAfterTimeout(paths, timeoutMs),
  ].join(' ; ')
}

/**
 * After a timeout, end what the command left running — and only after a timeout.
 *
 * Signalling the command alone does not bound anything: `sh -c 'sleep 300 & wait'` answers
 * SIGTERM with exit 143 while its child keeps running in the wrapper's group, and this backend's
 * liveness rule reads a non-empty group as a live turn — correctly, since something of it is —
 * so the caller's wait carries on past the deadline it set. A turn's `git`, `bun` and language
 * servers are exactly that remainder, and the group is the only handle on it.
 *
 * Two details are load-bearing. The reap runs *after* the exit record is published — the rename
 * included, since a record still under its pending name is one no reader can find — because the
 * group includes the wrapper, and the other order leaves the record never written at all. And
 * the group is named as `-$$` rather than `0`: both mean "my process group" when the wrapper
 * leads one, which under `setsid` it does, but a session that ever failed to start it that way
 * would have `0` name the *orchestrator's* group and kill the application. `-$$` on a wrapper
 * that leads no group names a group that does not exist, which fails harmlessly.
 */
function reapAfterTimeout(paths: JournalPaths, timeoutMs?: number): string[] {
  if (timeoutMs === undefined) {
    return []
  }
  return [`[ -f ${quoteArg(paths.timeout)} ] && kill -KILL -$$ 2> /dev/null`]
}

/**
 * The wrapper's own pid, recorded before anything else runs.
 *
 * Under `setsid` the wrapper is a session and process-group leader, so `$$` is the group id as
 * well — the handle a kill of the *whole turn* is aimed at, and the one thing no later
 * bookkeeping can recover once the wrapper is gone. It is written first for exactly that
 * reason: every line after it can fail and still leave the group killable.
 */
function pgidRecord(paths: JournalPaths): string {
  return `printf '%s' "$$" > ${quoteArg(paths.pgid)}`
}

/**
 * Hand the exit status to the journal in a state a reader can only see whole.
 *
 * A plain redirection publishes in two observable steps: `>` truncates the target when the
 * command is set up, and the `printf` fills it some time after. The state in between is a
 * zero-byte file, which the reader already answers as "not written yet", so the plain form is
 * not *wrong* — it is correct by an argument about how a three-byte write behaves rather than by
 * construction. This is the record that settles whether a turn is over, which is not a thing to
 * hold by an argument when POSIX will hold it outright: `rename(2)` within one directory is
 * atomic, so a reader sees no file or the finished status and never a prefix.
 *
 * The pending file is a *sibling* of its target and not somewhere under `TMPDIR`, because `mv`
 * across filesystems is a copy followed by a delete — the non-atomic publication this exists to
 * remove, reintroduced by the fix for it.
 *
 * A wrapper killed between the two commands leaves the pending file and no record, which is the
 * same answer as one killed before either: nothing was published, and the caller reads it as
 * {@link import('@amond-ai/sandbox').SandboxNoExitRecordError} rather than as an exit that never
 * happened.
 */
function publish(variable: string, paths: JournalPaths): string[] {
  // Two things about this `mv` are not incidental. `command -p` resolves it on the system
  // default PATH rather than on the command's own: `SandboxExecOptions.env` exists to be
  // narrowed, and an env without a usable PATH would otherwise leave every command in the
  // sandbox unable to publish, so turns that ended fine would all come back as `no_exit_record`.
  // And `--`, because a journal root beginning with `-` makes the pending path an option rather
  // than an operand, which quoting does not change: `mv: illegal option -- w`.
  return [
    `printf '%s' "${variable}" > ${quoteArg(paths.exitPending)}`,
    `command -p mv -- ${quoteArg(paths.exitPending)} ${quoteArg(paths.exit)}`,
  ]
}

/** The redirection both streams take, and the anchor {@link parseJournalScript} derives. */
function redirection(paths: JournalPaths): string {
  return ` > ${quoteArg(paths.out)} 2> ${quoteArg(paths.err)}`
}

/**
 * The per-command deadline, enforced from inside the sandbox.
 *
 * `kill -0` first, so a command that finished on time is not marked as timed out by a watchdog
 * that woke a moment later. The marker is written *before* the signal, because the reader can
 * only ever see the file after the fact and the other order leaves a window where a killed
 * command reads as one that failed on its own.
 *
 * It is redirected straight at its path rather than published through {@link publish}, and the
 * difference is that nobody reads its contents — the whole record is the file's existence, which
 * the redirection establishes in one step. The `t` is there to make the file legible to a human
 * looking at a journal root.
 */
function watchdog(paths: JournalPaths, timeoutMs?: number): string[] {
  if (timeoutMs === undefined) {
    return []
  }
  const seconds = Math.max(0, timeoutMs) / 1000
  return [
    `{ sleep ${seconds} ; kill -0 $__c 2> /dev/null`
    + ` && { printf t > ${quoteArg(paths.timeout)} ; kill -TERM $__c 2> /dev/null`
    + ` ; sleep ${TIMEOUT_GRACE_SECONDS} ; kill -KILL $__c 2> /dev/null ; } ; } & __w=$!`,
  ]
}

/** The id back out of a path set, so the script does not have to be handed it twice. */
function journalIdOf(paths: JournalPaths): string {
  const slash = paths.exit.lastIndexOf('/')
  return paths.exit.slice(slash + 1, -'.exit'.length)
}

/** What a journal script says about itself when its meta file is gone. */
export interface RecoveredScript {
  id: string
  command: SandboxCommand
}

/**
 * Read a wrapper's rendered command line back into the process it is running.
 *
 * The path recovery takes, and the only one there is: Vercel has no process listing, so a turn
 * whose meta file was never written — the command id is not known before the command starts —
 * or was deleted by the turn itself is otherwise live and unnamed. The line is the wrapper's
 * `/proc/<pid>/cmdline` with its NUL separators rendered as spaces, which is exactly `sh -c
 * <script>`.
 *
 * The id is read from the opener and everything else is then *derived* from it rather than
 * scanned for. That is what keeps attacker-influenced text out of the decision: a prompt carries
 * an issue body, an issue body can quote any marker this module emits, and the check that
 * survives that is "the bookkeeping and the redirection target the files this journal root would
 * give that id" — strings the wrapper cannot be talked into containing unless it really is ours.
 *
 * Anchored at the start of the line, not searched for anywhere in it. A marker *found* in a
 * command line says only that some process has this text among its arguments — a `grep` for it,
 * or the turn's own `claude` carrying it inside a prompt. What recovery finds is handed to a
 * caller that may signal it, so matching a stranger is not a wrong label but a killed bystander.
 */
export function parseJournalScript(line: string, root: string): RecoveredScript | undefined {
  if (!line.startsWith(WRAPPER_PREFIX)) {
    return undefined
  }
  const from = WRAPPER_PREFIX.length
  const idEnd = line.indexOf(SCRIPT_OPEN_CLOSE, from)
  if (idEnd < 0) {
    return undefined
  }
  const id = line.slice(from, idEnd)
  if (!isProcessId(id)) {
    return undefined
  }
  const paths = journalPaths(root, id)
  const head = `${SCRIPT_OPEN_CLOSE}${pgidRecord(paths)} ; ${ARGV_OPEN}`
  if (!line.startsWith(head, idEnd)) {
    return undefined
  }
  const argvFrom = idEnd + head.length
  const argvTo = line.lastIndexOf(`${ARGV_CLOSE}${redirection(paths)} & __c=$!`)
  if (argvTo < argvFrom) {
    return undefined
  }
  const command = unquoteArgv(line.slice(argvFrom, argvTo))
  return command ? { id, command: command as unknown as SandboxCommand } : undefined
}

/** What the backend must remember about a process once the session no longer will. */
export interface JournalMeta {
  id: string
  /**
   * Vercel's command id, which `getCommand` resolves back into a handle.
   *
   * Kept even though the journal answers every question the handle does, because it is the only
   * way back to the SDK's own view of the command — and the only thing that says which command
   * of a session's many this process was.
   */
  cmdId: string
  /**
   * The session {@link cmdId} belongs to.
   *
   * The field that makes the journal necessary rather than merely convenient: a command id is
   * scoped to the VM that ran it, so a sandbox resumed into a new session cannot resolve it at
   * all. Recorded so the reader can tell "this handle is stale" from "this command is gone".
   */
  sessionId: string
  /** Non-empty by construction: a meta recording no command records nothing that ran. */
  command: SandboxCommand
  cwd?: string
  /** When this backend started it, ISO-8601. Reported to callers. */
  startedAt: string
}

export function serializeJournalMeta(meta: JournalMeta): string {
  return JSON.stringify(meta)
}

/**
 * Read a meta record back, or `undefined` when the file is absent, truncated or not one.
 *
 * A missing journal is a normal state — the process may not have started — so this reports
 * absence rather than throwing, and the caller decides whether absence is a failure.
 */
export function parseJournalMeta(raw: string): JournalMeta | undefined {
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
  const candidate = parsed as Partial<JournalMeta>
  // Every field is checked, not just the shape. This file lives on a filesystem the turn itself
  // writes to, so `["claude", 5]` must not pass the cast and violate `SandboxCommand`'s own
  // tuple invariant downstream — and neither must an `id` no journal path can be built from,
  // which a listing would carry to a `journalPaths()` call that throws for the whole sandbox
  // rather than for the one malformed file.
  if (typeof candidate.id !== 'string' || !isProcessId(candidate.id)
    || typeof candidate.cmdId !== 'string' || typeof candidate.sessionId !== 'string'
    || !Array.isArray(candidate.command) || candidate.command.length === 0
    || !candidate.command.every(element => typeof element === 'string')
    || typeof candidate.startedAt !== 'string') {
    return undefined
  }
  return candidate as JournalMeta
}
