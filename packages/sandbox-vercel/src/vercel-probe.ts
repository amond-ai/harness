/**
 * One shell command that answers everything a poll needs to know about a turn.
 *
 * This is the architectural centre of the package, and the reason it looks nothing like the e2b
 * backend's polling path. Every fact the orchestrator asks for while a turn runs — how far each
 * journal file has grown, whether an exit was recorded, whether the wrapper's deadline fired,
 * and whether anything is still running — is produced by a single `runCommand`. The e2b backend
 * spends two file reads, a `commands.list` and a `pgrep` per poll to answer the same four
 * questions, and pays for it twice: four round trips of latency, and four *separately timed*
 * observations that have to be reconciled afterwards (`e2b-session.ts:306-314` re-probes for
 * exactly that reason). One command makes the four facts one observation, taken in an order this
 * file chooses.
 *
 * The command always exits 0 and prints five newline-separated fields, because an exit code is a
 * single bit and this has to distinguish "the turn is gone" from "the probe could not run" —
 * collapsing those is how an orchestrator starts a second `claude` in a checkout that already
 * has one. A non-zero exit therefore means the *probe* failed, never anything about the turn.
 */
import type { JournalMeta } from './journal'
import type { VercelCommandLike, VercelSandboxLike } from './vercel-surface'
import { journalPaths, WRAPPER_SHELL, wrapperMarker } from './journal'
import { quoteArg } from './shell-quote'
import { isNotFound } from './vercel-surface'

/**
 * How many bytes of the exit record the probe brings back.
 *
 * `printf '%s' "$__e"` writes at most three digits, and the file is the turn's to write. This is
 * read on every poll for the whole length of a turn, so the cap is what keeps a turn from making
 * the orchestrator buffer an inflated file thousands of times — and unlike the journal reader's
 * cap, this one is applied *inside the sandbox*, so the bytes never cross the wire at all.
 */
const EXIT_RECORD_LIMIT = 32

/**
 * What the wrapper's process group is doing, as the probe observed it.
 *
 * `'stranger'` and `'none'` are both "not this turn" and answer {@link Liveness} identically —
 * the distinction exists for the kill path alone. `'none'` is a group that is simply empty, and
 * a kill aimed at it is a harmless no-op that falls through to the command's own pid;
 * `'stranger'` is a pgid some *other* process now leads, where that same kill would reach a
 * bystander. Collapsing the two would make the kill path choose between killing strangers and
 * refusing to kill a turn whose wrapper has merely exited.
 */
export type GroupState = 'live' | 'survivors' | 'none' | 'stranger' | 'unknown'

/**
 * Whether the turn is still running — and, separately, whether we know.
 *
 * A tri-state rather than a boolean, and `'unknown'` must never be collapsed into `'gone'`. The
 * caller's only use of `'gone'` is to stop waiting and report `no_exit_record`, which settles a
 * run as failed and releases the checkout to a retry; answering it because a `runCommand` was
 * refused would release a checkout a live agent is still writing to.
 */
export type Liveness = 'live' | 'gone' | 'unknown'

export interface ProbeReading {
  liveness: Liveness
  /** The raw group observation, kept so a kill can tell a survivor from an unreadable probe. */
  group: GroupState
  /**
   * Whether the probe command ran and its output parsed at all.
   *
   * Distinct from `liveness === 'unknown'`, which a probe that ran perfectly well also reports
   * when the wrapper has not written its `.pgid` yet. The follow read is what needs the
   * difference: it starts a `from: 'tail'` subscription at {@link out}/{@link err}, and `-1`
   * from a probe that *answered* means "no file yet, start at 0" while `-1` from one that could
   * not run means nothing at all — starting at 0 there would replay a whole transcript into a
   * subscriber that asked for none of it.
   */
  answered: boolean
  /** Bytes in the stdout journal, or `-1` when the file is not there or was not readable. */
  out: number
  err: number
  /** Whether the wrapper's own watchdog marked this command as having hit its deadline. */
  timedOut: boolean
  /** The journalled exit code, when one has been published and parses as a number. */
  exitCode?: number
  /**
   * Whether {@link exitCode} came from Vercel rather than from the journal file.
   *
   * The trust boundary, as a field. `<id>.exit` is written by the turn and can be forged; a
   * command's `exitCode` is the API's own record. `statusOf` and `waitForExit` settle a process
   * on a corroborated code alone, and on a journalled one only once the liveness verdict agrees
   * the group is gone — so a turn that writes an exit for itself while still running cannot end
   * its own wait.
   */
  corroborated: boolean
}

/** What every unanswerable probe reads as. Never `'gone'`; see {@link Liveness}. */
const UNREADABLE: ProbeReading = {
  liveness: 'unknown',
  group: 'unknown',
  answered: false,
  out: -1,
  err: -1,
  timedOut: false,
  corroborated: false,
}

/**
 * The probe script, as the sandbox's `sh` will run it.
 *
 * Five decisions live in this string, and each of them is load-bearing:
 *
 * - **Liveness is read first and the exit record last.** The unsound reading this removes is
 *   "the wrapper was gone at T1, and there was no exit record at T2 > T1" reported as
 *   `no_exit_record` — which is wrong exactly when the wrapper published between the two, and
 *   that is the most likely moment for it to have happened, since the wrapper exits microseconds
 *   after the rename. Taken in this order, a gone-then-absent pair is a true negative: nothing
 *   was running when we looked, and nothing had been written by the later moment either.
 * - **`kill -0 -- -$g`, not `pgrep -g`.** `kill` is a shell builtin and is therefore in every
 *   image; `pgrep` is procps, which the sandbox image is not obliged to carry. A probe that
 *   depends on a package answers `'unknown'` forever on an image that lacks it.
 * - **`wc -c` for the lengths, `-1` when the file is absent.** This is what makes a quiet follow
 *   free: the watchdog learns the transcript has not grown without transferring a byte of it,
 *   and the whole-file read the journal reader has to do is only issued once a length says there
 *   is something new to fetch.
 * - **`head -c 32` on the exit record**, for the reason {@link EXIT_RECORD_LIMIT} gives.
 * - **Liveness requires the cmdline marker.** A pid alone proves nothing: pids are recycled, and
 *   `kill -0` against a recycled one succeeds. `/proc/<pid>/cmdline` with its NUL separators
 *   rendered as spaces must *start with* this process's own wrapper marker, or the pid is a
 *   stranger and reads as `'none'`. What the caller does with a `'live'` answer includes
 *   signalling it, so a mismatch here is not a wrong label but a killed bystander.
 *
 * The last of those is why the group is only consulted when `/proc/<pid>/cmdline` is **empty**,
 * and that branch order is the substantive part of this script rather than a tidying of it. A
 * stranger that recycled the pid and happens to lead its own group would answer `kill -0 -- -$g`
 * perfectly well, so asking the group first reports an unrelated process as this turn's
 * survivors. What makes the split sound is a kernel invariant: a pid cannot be reused while a
 * process group of that id still has members, so an unreadable `/proc/<pid>` and a non-empty
 * group together can only be *our* orphans — the wrapper gone, its children still running —
 * while a readable one means the pid is in use and its command line is the whole answer.
 *
 * The pattern match is `case` against a *variable*, not against an interpolated literal: the
 * marker contains quotes and spaces, and a quoted variable in a `case` pattern is matched
 * literally rather than expanded as a glob.
 */
export function probeScript(processId: string, root: string): string {
  const paths = journalPaths(root, processId)
  const marker = quoteArg(wrapperMarker(processId))
  // Every file is opened by redirection rather than passed as an operand, so a journal root
  // beginning with `-` cannot turn a path into an option — the same hazard `command -p mv --`
  // closes in the wrapper itself.
  return [
    `m=${marker}`,
    // `2> /dev/null` comes *before* the input redirection, not after it. The shell applies
    // redirections left to right and reports a failed `<` itself, so with the usual order the
    // "No such file or directory" for a journal file that does not exist yet is written to the
    // probe's stderr with fd 2 still attached — measured against a real `sh`, 2026-09-14. Every
    // poll of a turn before its first write would carry that noise.
    `g=$(cat 2> /dev/null < ${quoteArg(paths.pgid)})`,
    `c=$(tr 2> /dev/null '\\0' ' ' < /proc/"$g"/cmdline)`,
    `if [ -z "$g" ] ; then printf '%s\\n' nopid`,
    // The pid is in use, so it settles the question on its own: ours, or a stranger that
    // inherited the number. A stranger reads as `stranger` rather than `none` even though
    // `kill -0 -- -$g` would have succeeded on the group it leads — the two are the same
    // liveness answer and a different kill target; see {@link GroupState}. See
    // {@link probeScript} on why the empty-cmdline branch is the only one allowed to ask about
    // the group at all.
    `elif [ -n "$c" ] ; then case $c in "$m"*) printf '%s\\n' live ;;`
    + ` *) printf '%s\\n' stranger ;; esac`,
    `else if kill -0 -- -"$g" 2> /dev/null ; then printf '%s\\n' survivors`
    + ` ; else printf '%s\\n' none ; fi ; fi`,
    length(paths.out),
    length(paths.err),
    `if [ -f ${quoteArg(paths.timeout)} ] ; then printf '%s\\n' t ; else printf '%s\\n' '' ; fi`,
    `head -c ${String(EXIT_RECORD_LIMIT)} 2> /dev/null < ${quoteArg(paths.exit)}`,
    // The probe's own exit code says whether the *probe* ran, and nothing about the turn, so the
    // last command's status must not leak into it: `head` on an absent exit record exits
    // non-zero on every poll of a turn that has not finished, which is almost all of them.
    `exit 0`,
  ].join(' ; ')
}

/** One journal file's length, or `-1` when there is no such file yet. */
function length(path: string): string {
  return `if [ -f ${quoteArg(path)} ] ; then printf '%s\\n' "$(wc -c < ${quoteArg(path)})"`
    + ` ; else printf '%s\\n' -1 ; fi`
}

/**
 * The probe's five fields, read back.
 *
 * Anything that is not five fields of the shape this module writes reads as {@link UNREADABLE} —
 * a truncated response, an image whose `sh` differs, a field order that drifted. The exit record
 * is the *last* field precisely so a turn that forged a multi-line one cannot shift the fields
 * before it; everything after the fourth newline is the record, whatever it contains.
 */
export function parseProbeOutput(text: string): ProbeReading {
  const fields = text.split('\n')
  if (fields.length < 5) {
    return UNREADABLE
  }
  const group = groupStateOf(fields[0] ?? '')
  return {
    liveness: livenessOf(group),
    group,
    answered: true,
    out: countOf(fields[1] ?? ''),
    err: countOf(fields[2] ?? ''),
    timedOut: (fields[3] ?? '').trim() === 't',
    exitCode: exitCodeOf(fields.slice(4).join('\n')),
    corroborated: false,
  }
}

function groupStateOf(field: string): GroupState {
  const word = field.trim()
  if (word === 'live' || word === 'survivors' || word === 'none' || word === 'stranger') {
    return word
  }
  // `nopid` — the wrapper never recorded its group, which is a real state for a command whose
  // very first `printf` has not landed — and anything unrecognised alike.
  return 'unknown'
}

/**
 * A group observation, as the liveness question the contract asks.
 *
 * `'survivors'` is `'live'`, and that is the substantive judgement here: the wrapper shell has
 * exited but something it started has not, and a turn whose `git` or language server
 * demonstrably has not stopped has not stopped. Reporting it as finished is what lets a retry
 * clone over a tree another process is still writing to.
 *
 * `'stranger'` is `'gone'`, exactly as `'none'` is: a pgid another process now leads says
 * nothing about our turn except that it is not there. The two part company only in
 * {@link GroupState}, which the kill path reads to tell a harmless kill from a bystander.
 */
function livenessOf(group: GroupState): Liveness {
  switch (group) {
    case 'live':
    case 'survivors':
      return 'live'
    case 'none':
    case 'stranger':
      return 'gone'
    default:
      return 'unknown'
  }
}

/** `wc -c`'s answer, or `-1` for anything this cannot make a length of. */
function countOf(field: string): number {
  const value = Number(field.trim())
  return Number.isSafeInteger(value) && value >= 0 ? value : -1
}

function exitCodeOf(record: string): number | undefined {
  const trimmed = record.trim()
  if (trimmed === '') {
    return undefined
  }
  const code = Number(trimmed)
  return Number.isInteger(code) ? code : undefined
}

export interface JournalProbeOptions {
  /**
   * Commands *this isolate* started, keyed by process id.
   *
   * A short circuit for the warm path and nothing more: a handle held here needs no `getCommand`
   * round trip to report an exit code. Stage 3 owns the map; an empty one changes no answer.
   */
  execCommands?: Map<string, VercelCommandLike>
  /** The sandbox's own budget for the probe command, so a wedged probe cannot hang a poll. */
  timeoutMs?: number
}

export interface JournalProbe {
  read: (meta: JournalMeta) => Promise<ProbeReading>
}

export function createJournalProbe(
  sandbox: VercelSandboxLike,
  root: string,
  options: JournalProbeOptions = {},
): JournalProbe {
  /** The shell probe alone: the reading every answer is built from. */
  async function shellProbe(processId: string): Promise<ProbeReading> {
    try {
      const ran = await sandbox.runCommand({
        cmd: WRAPPER_SHELL,
        args: ['-c', probeScript(processId, root)],
        timeoutMs: options.timeoutMs,
      })
      // The script ends in `exit 0`, so a non-zero code here is the sandbox refusing to run it
      // at all — a fact about the transport, from which nothing about the turn follows.
      return ran.exitCode === 0 ? parseProbeOutput(await ran.stdout()) : UNREADABLE
    }
    catch {
      return UNREADABLE
    }
  }

  /**
   * The exit code Vercel recorded, when it can still be asked for.
   *
   * Worth preferring because of who wrote it: `<id>.exit` lives on a filesystem the turn itself
   * can write to, while a command's `exitCode` is the API's own record of how the process it
   * started ended. A turn cannot forge that.
   *
   * Deliberately **not** load-bearing, and every branch here reflects it. A command id is scoped
   * to the session that ran it, so a sandbox resumed into a new session — which is the ordinary
   * state a retried workflow step reattaches to — can resolve nothing, and a cold provider has
   * only the journal files. Everything must keep working there, so a mismatch, a 404 and a
   * failed lookup all answer the same thing: nothing, and the shell probe stands alone.
   */
  async function vercelExit(meta: JournalMeta): Promise<number | undefined> {
    const started = options.execCommands?.get(meta.id)
    if (started) {
      return started.exitCode ?? undefined
    }
    if (meta.cmdId === '' || meta.sessionId !== sandbox.sessionId()) {
      return undefined
    }
    try {
      return (await sandbox.getCommand(meta.cmdId)).exitCode ?? undefined
    }
    catch (cause) {
      // A 404 is the expected shape for a command the session no longer holds; anything else is
      // a transport failure. Neither is reported, because neither costs the caller an answer —
      // corroboration that could not be obtained simply is not applied.
      if (!isNotFound(cause)) {
        console.warn(`sandbox-vercel: could not corroborate '${meta.id}' against its command: ${String(cause)}`)
      }
      return undefined
    }
  }

  return {
    read: async (meta) => {
      // Issued together: the shell probe is the reading, and the corroboration only ever
      // replaces one field of it, so running them in sequence would add a round trip to every
      // poll of a warm turn for no extra fact.
      const [reading, corroborated] = await Promise.all([shellProbe(meta.id), vercelExit(meta)])
      // Only the exit code. Liveness stays the probe's, because Vercel's command is the
      // `setsid` wrapper: it having exited says nothing about the children in its group, which
      // is the whole question `'survivors'` exists to answer.
      return corroborated === undefined
        ? reading
        : { ...reading, exitCode: corroborated, corroborated: true }
    },
  }
}
