/**
 * Reading e2b's own process table — the half of a process's story the turn cannot rewrite.
 *
 * Split from `e2b-session.ts` for the 500-LOC limit (cubic review, PR #260). Its counterpart
 * is `journal-io.ts`: the journal records what a turn *claims*, this module records what e2b
 * still has running, and every trust decision in this backend resolves to preferring the
 * second over the first.
 */
import type { SandboxCommand } from '@pleaseai/sandbox-contract'
import type { E2bSandboxLike } from './e2b-surface'
import type { JournalMeta } from './journal'
import { ARGV_CLOSE, ARGV_OPEN, isProcessId, journalledScriptIn, STDOUT_SUFFIX } from './journal'
import { unquoteArgv, unquoteFirstArg } from './shell-quote'

/**
 * How long the kill walk gets before it is abandoned for e2b's own `kill`.
 *
 * A session's `commandTimeoutMs` defaults to `0` — unbounded — because a turn may legitimately
 * run for hours. The walk is `pgrep` and `kill` only, and unlike a turn it is *awaited*, so an
 * unbounded budget would turn an unresponsive sandbox into a kill that never returns.
 */
const KILL_WALK_TIMEOUT_MS = 30_000

/**
 * What a liveness probe learned — and, third case, that it learned nothing.
 *
 * `'unknown'` exists because `commands.list()` is a network call that can fail on its own,
 * and collapsing that into `'gone'` (as a boolean must) makes one transient RPC error
 * indistinguishable from an exited process. See `e2b-session.ts`'s `statusOf` for what that
 * costs.
 */
export type Liveness = 'live' | 'gone' | 'unknown'

/** How long the session probe gets: two `pgrep`s worth of work, so a budget, not a wait. */
const SESSION_PROBE_TIMEOUT_MS = 15_000

/**
 * What is left of a wrapper's own session — and, third case, that the probe could not say.
 *
 * `'unknown'` is kept apart from `'none'` for the reason {@link Liveness} keeps it apart from
 * `'gone'`: this answer decides whether a turn may be declared finished, and a probe that
 * failed knows nothing about the turn. Collapsing the two would make one failed round trip
 * indistinguishable from an empty session, which is the reading that ends an attempt.
 */
export type SessionSurvivors = 'survivors' | 'none' | 'unknown'

/**
 * How {@link WrapperTable.killTree} ended: the walk reaped the tree, e2b's own kill stood in
 * for it, or nothing was signalled at all.
 *
 * Returned rather than only logged, because the three are not the same event and the caller
 * acts on the difference. `commands.kill` SIGKILLs the wrapper, which cannot propagate it, so
 * a `'fallback'` leaves the wrapped command reparented to init and running. Resolving
 * identically for that and a reap is how an unconfirmed kill came to be reported as a
 * confirmed one (codex review, PR #260, round 16).
 *
 * `'walk-failed'` is the third state, and the reason it exists: e2b's kill is SIGKILL-only,
 * so it cannot stand in for a *gentler* signal. A failed walk during the SIGINT stage that
 * fell back would hard-kill the wrapper and end the turn with no `result` — the exact outcome
 * the interrupt stage exists to avoid — so the requested signal is kept, nothing is sent, and
 * the caller is told the tree's liveness is untouched and unknown.
 */
export type KillOutcome = 'reaped' | 'fallback' | 'walk-failed'

/** POSIX numbers `kill -<name>` spells by name; anything else is passed as its number. */
const SIGNAL_NAMES: Readonly<Record<number, string>> = { 2: 'INT', 9: 'KILL', 15: 'TERM' }

/** The one signal e2b's own `commands.kill` sends, and so the only one it can stand in for. */
const SIGKILL = 9

/** What `kill -…` and `pkill -…` are given for a contract signal; unset means the SIGKILL reap. */
export function signalFlag(signal: number | undefined): string {
  if (signal === undefined) {
    return 'KILL'
  }
  return SIGNAL_NAMES[signal] ?? String(signal)
}

/**
 * What e2b's process table says about one journal wrapper.
 *
 * `commandLine` is carried alongside the pid because it is the *argv* that the
 * duplicate-turn guard matches on, and while a process is listed this is the only copy of it
 * the turn cannot rewrite.
 */
export interface ListedWrapper {
  pid?: number
  commandLine?: string
}

/** What a listing says about liveness — `undefined` being a failed listing, not an absence. */
export function livenessFrom(listed: ListedWrapper | undefined): Liveness {
  if (!listed) {
    // The listing failed, which says nothing about the process. Reporting `gone` here
    // would make a dropped connection look exactly like a dead process.
    return 'unknown'
  }
  return listed.pid === undefined ? 'gone' : 'live'
}

export interface WrapperTable {
  livenessOf: (id: string) => Promise<Liveness>
  listedWrapper: (id: string) => Promise<ListedWrapper | undefined>
  recoveredProcesses: () => Promise<Map<string, JournalMeta>>
  recoveredCommand: (commandLine: string) => SandboxCommand
  sessionSurvivors: (sid: number) => Promise<SessionSurvivors>
  confirmReaped: (id: string, pid: number, via: string) => Promise<void>
  /** Reap the tree under `pid`; `signal` (a contract number) replaces the default SIGKILL. */
  killTree: (pid: number, signal?: number) => Promise<KillOutcome>
  /** Signal a whole session by id, for a leader that is already gone. */
  killSession: (sid: number, signal?: number) => Promise<KillOutcome>
}

export function createWrapperTable(
  sandbox: E2bSandboxLike,
  root: string,
  now: () => string,
): WrapperTable {
/** What e2b reports a listed process was started as, argv included. */
  function commandLineOf(process: { cmd?: string, args?: string[] }): string {
    return [process.cmd ?? '', ...(process.args ?? [])].join(' ')
  }

  /**
   * Is the wrapper for this process still in e2b's table?
   *
   * Identified by the id its own command line carries rather than by `meta.pid`, because the
   * meta file lives in the sandbox the turn writes to. Trusting the pid there re-opened the
   * exact hole the liveness check closes: rewrite `pid` to something that is not running,
   * write an exit file, and a forged exit is accepted while `claude` keeps going (codex
   * review, PR #260). `journalledCommand` puts the journal path in the redirection it writes
   * itself, so the match is against a string only e2b can report and only a genuinely running
   * wrapper carries.
   *
   * A turn can still spawn some other process whose *own* redirection names this journal and
   * look alive longer than it is. That direction is harmless — it delays its own exit being
   * noticed until the caller's own budget runs out; it cannot manufacture a finished attempt.
   */
  async function livenessOf(id: string): Promise<Liveness> {
    return livenessFrom(await listedWrapper(id))
  }

  /**
   * What e2b lists for this process's wrapper — `undefined` when the listing itself failed,
   * `{ pid: undefined }` when it succeeded and named nothing.
   *
   * The pid is taken from here rather than from the journal for {@link livenessOf}'s reason,
   * and {@link killTree} needs it for the same one: a kill aimed by the journal is a kill the
   * turn chooses the target of.
   *
   * Matched through {@link journalIdIn} rather than by looking for the raw stdout path in the
   * line: the path appears there *quoted*, and `quoteArg` does not keep one containing a `'`
   * in a single pair of quotes — a journal root with a quote in it would make every wrapper
   * unfindable, and every running turn read as gone (cubic review, PR #260).
   */
  async function listedWrapper(id: string): Promise<ListedWrapper | undefined> {
    try {
      const listed = await sandbox.commands.list()
      const found = listed
        .map(process => ({ pid: process.pid, commandLine: commandLineOf(process) }))
        .find(process => journalIdIn(process.commandLine) === id)
      return found ?? {}
    }
    catch {
      return undefined
    }
  }

  /**
   * Every process e2b is running a journal wrapper for, recovered from its own listing.
   *
   * The journal is the turn's to delete, and discovery reads it: `getProcess` returns `null`
   * for a missing meta and `listProcesses` enumerates meta files. `killTurn` treats a `null`
   * lookup as a *confirmed death* and starts the next attempt, so erasing one file was
   * enough to be declared dead and have a second `claude` started in the same checkout
   * (codex review, PR #260). e2b's listing is the record the turn cannot erase.
   *
   * A failed listing throws rather than reporting none: this feeds the duplicate-turn guard,
   * where "the API blipped" must not arrive as "nothing is running".
   */
  async function recoveredProcesses(): Promise<Map<string, JournalMeta>> {
    const listed = await sandbox.commands.list()
    const recovered = new Map<string, JournalMeta>()
    for (const process of listed) {
      const line = commandLineOf(process)
      const id = journalIdIn(line)
      if (id !== undefined && !recovered.has(id)) {
        recovered.set(id, {
          id,
          pid: process.pid,
          command: recoveredCommand(line),
          startedAt: now(),
        })
      }
    }
    return recovered
  }

  /**
   * What a recovered process is running, read back out of its own wrapper.
   *
   * Recovered from the wrapper rather than from the meta because `liveTurnProcess` matches a
   * discovered process against the argv it is about to start — a recovered turn it cannot
   * recognise is one it starts a second copy of. Falls back to the whole command line, which
   * is at least truthful about what is running.
   */
  function recoveredCommand(commandLine: string): SandboxCommand {
    const argv = unquoteArgv(wrappedArgvIn(commandLine) ?? '')
    const [executable, ...args] = argv ?? []
    return executable === undefined ? [commandLine] : [executable, ...args]
  }

  /**
   * The process id a wrapper's own stdout redirection names, if this journal owns it.
   *
   * Read from *after* the argv, never by searching the whole line. The argv is
   * tracker-authored prompt text, so a prompt saying `/home/user/.agent-runs/fake.out` would
   * otherwise file the live wrapper under `fake`: the real id then looks absent, `killTurn`
   * reads that as a confirmed death, and the next attempt starts beside a running turn —
   * the exact hole this recovery exists to close (codex and cubic reviews, PR #260).
   *
   * Everything past the last `ARGV_CLOSE` is written by `journalledCommand` itself, so the
   * redirection there is the one piece of the line no prompt can reach. It is unquoted with
   * the inverse of the rule that wrote it rather than scanned to the next quote, because
   * `quoteArg` does not keep a path in one pair of quotes — a journal root containing a `'`
   * would be truncated, and every live process under it would read as gone.
   */
  function journalIdIn(commandLine: string): string | undefined {
    const script = journalledScriptIn(commandLine)
    const closed = script.lastIndexOf(ARGV_CLOSE)
    if (closed < 0) {
      return undefined
    }
    const path = unquoteFirstArg(script.slice(closed + ARGV_CLOSE.length))?.value
    const prefix = `${root}/`
    if (path === undefined || !path.startsWith(prefix) || !path.endsWith(STDOUT_SUFFIX)) {
      return undefined
    }
    const id = path.slice(prefix.length, -STDOUT_SUFFIX.length)
    return isProcessId(id) ? id : undefined
  }

  /**
   * The quoted argv inside a wrapper's command line.
   *
   * Bounded by `lastIndexOf` on the closing brace: the argv is attacker-influenced text that
   * can contain the terminator verbatim, and it always precedes the real one.
   */
  function wrappedArgvIn(commandLine: string): string | undefined {
    const script = journalledScriptIn(commandLine)
    const opened = script.indexOf(ARGV_OPEN)
    const closed = script.lastIndexOf(ARGV_CLOSE)
    return opened >= 0 && closed > opened ? script.slice(opened + ARGV_OPEN.length, closed) : undefined
  }

  /**
   * Is anything still running in the session a wrapper led?
   *
   * The question `commands.list()` cannot answer. e2b lists only the processes it started
   * itself, so a child the turn detached — and then orphaned by killing the wrapper — is
   * invisible to exactly the table this backend trusts (#266). `journalledCommand` starts the
   * wrapper under `setsid --wait`, which measurably gives it a session of its own
   * (`scripts/spike-e2b-session.ts`): after `commands.kill(pid)` on such a wrapper,
   * `pgrep -s <sid>` returned the orphaned `sh` and its `sleep`, reparented to init and still
   * in the wrapper's session.
   *
   * The session id is the wrapper's **pid**. Not a value read back from anywhere the turn can
   * write — a recorded sid could be pointed at an empty session, which is the forgery this
   * closes — but the measured consequence of how envd starts a command: `setsid` execs rather
   * than forks there, so the wrapper *is* the session leader and `sid === pid` held 8/8 across
   * four runs of each shape. It also cannot be read afterwards: `ps -o sid= -p <pid>` on an
   * exited wrapper prints nothing, so this has to be derivable up front.
   *
   * A pid of `0` or less is a process reached through the journal files alone, which never
   * recorded one. Nothing is issued for it: `pgrep -s 0` means *the caller's own session*, so
   * asking would report a survivor for every such process forever.
   *
   * The probe always exits `0` and says which it found in stdout, so a `pgrep` that matched
   * nothing — exit `1` — is not indistinguishable from a probe that could not run.
   *
   * **What this binds, and what it does not.** The caller supplies the session id, and its
   * only source for an exited process is `meta.pid` — a field in the file the turn itself
   * writes. So this reaches a turn that forges an exit *without* touching its meta, which is
   * the shape #266 describes, and it reaches neither of the two ways of touching it:
   *
   * - **rewrite.** `meta.pid` is set to any other number, and the probe asks about a session
   *   that is not the wrapper's.
   * - **delete.** With no meta, `getProcess` reattaches through the journal files alone and
   *   `withoutMeta` supplies `pid: 0`, for which nothing is asked at all. This is the cheaper
   *   of the two — one `rm`, no need to learn a pid first — so it is named here rather than
   *   left to be inferred from `withoutMeta`.
   *
   * Neither is a tolerable accident dressed up as a limit: they are the adversary this guard
   * exists for, deliberately disabling it. Closing them is one fix, not two, because both
   * spellings have the same root — the identity comes from a file the turn owns — and it
   * needs a session identity that does not (#277). `e2b-session.ts` already refuses the
   * journal for `command` and takes it from e2b's listing for exactly this reason; the
   * session id has no such second source yet, because a session cannot be read back once its
   * leader has exited.
   */
  async function sessionSurvivors(sid: number): Promise<SessionSurvivors> {
    if (!Number.isInteger(sid) || sid <= 0) {
      return 'none'
    }
    try {
      const probe = await sandbox.commands.run(
        `pgrep -s ${String(sid)} > /dev/null 2>&1 && printf survivors || printf none`,
        { background: true, timeoutMs: SESSION_PROBE_TIMEOUT_MS },
      )
      const { exitCode, stdout } = await probe.wait()
      if (exitCode !== 0) {
        return 'unknown'
      }
      if (stdout?.trim() === 'survivors') {
        return 'survivors'
      }
      return stdout?.trim() === 'none' ? 'none' : 'unknown'
    }
    catch {
      return 'unknown'
    }
  }

  /**
   * After a fallback kill, say whether the tree actually died — and refuse to claim it did.
   *
   * `commands.kill` SIGKILLs the wrapper only, leaving the wrapped command reparented to init
   * and running. Resolving as though the tree had been reaped is what `killTurn` reads as a
   * confirmed kill, after which it starts the next attempt in the same checkout (codex review,
   * PR #260, round 16). Only an *observed* survivor throws — a probe that could not run has
   * measured nothing, and failing every kill against an unreachable sandbox is not what it
   * learned. `killTurn` catches, re-reads `status()`, and reports the kill unconfirmed.
   */
  async function confirmReaped(id: string, pid: number, via: string): Promise<void> {
    const survivors = await sessionSurvivors(pid)
    console.warn(`sandbox-e2b: kill of '${id}' went through ${via}; session ${survivors}`)
    if (survivors === 'survivors') {
      throw new Error(`kill of '${id}' left processes running in its session`)
    }
  }

  /**
   * Reap a wrapper's whole session, or walk its tree when it does not own one.
   *
   * `journalledCommand` wraps the argv in a shell so `$?` can be journalled, so the pid e2b
   * tracks is that shell. `commands.kill` sends `SIGKILL`, which a shell can neither trap nor
   * propagate — measured (`scripts/spike-e2b-kill-tree.ts`, 2026-08-25): the `claude` child
   * was reparented to init, ran to completion, and no exit file was ever written. The
   * workflow then reads `no_exit_record`, settles the run failed, and retries into a checkout
   * a live agent is still writing to (codex review, PR #260).
   *
   * A session kill reaps that in one signal, and it does not take the reaper with it:
   * `pkill -KILL -s <sid>` against a `setsid` wrapper printed `reaper survived` and left the
   * session empty, because the reaper runs in envd's session and the victim in its own
   * (`scripts/spike-e2b-session.ts`).
   *
   * The condition is the hazard. Wrappers started before the session wrapping existed are
   * still running in sandboxes this code connects to, and they share session **511** with
   * envd itself — `pkill -KILL -s 511` would kill envd and destroy the sandbox. So the target
   * is asked, in the sandbox and at kill time, whether it is genuinely its own session leader
   * (`sid === pid`), and only then reaped by session; a legacy wrapper answers `511 != <pid>`
   * and gets the post-order `pgrep -P` walk it has always had. The test can only be satisfied
   * by a session leader, so the one pid it would license a session kill on is 511 itself —
   * which is never a pid this is handed, since it is the target of a wrapper e2b listed.
   *
   * Children-first in the walk still matters: a parent killed before its children leaves them
   * reparented to init and out of reach.
   *
   * Awaited to completion, not merely started. e2b returns from a background command as soon
   * as it starts, and two callers here — `materializationExit` and the meta-write failure
   * path — surface a retry the moment this resolves: without the wait, the next `git clone`
   * would race a process tree that is still being killed in the same checkout (codex and
   * cubic reviews, PR #260).
   */
  async function killTree(pid: number, signal?: number): Promise<KillOutcome> {
    return await runReap(reapCommand(pid, signal), pid, signal)
  }

  /**
   * Reap a session whose leader is already dead — the state {@link killTree} cannot serve.
   *
   * `reapCommand`'s `pkill -s` branch is gated on the target still answering `ps -o sid=` with
   * its own pid, and a dead leader answers nothing: the gate fails, the walk finds no children
   * of a dead pid, `kill` returns ESRCH into `|| true`, and the whole script exits `0` — a
   * reported reap that signalled nothing while the reparented `claude` runs on in that
   * session. That gate is a safety check about *which* pid may be session-reaped, and here the
   * caller has already made that judgement by other means: the pid is one this isolate
   * captured from `commands.run` for a `setsid --wait` wrapper (so it led its own session),
   * and it is only offered here while `sessionSurvivors` still reports members in it. A
   * session id is only reusable once its last member is gone, so an inhabited session under
   * that pid is still the wrapper's own.
   */
  async function killSession(sid: number, signal?: number): Promise<KillOutcome> {
    return await runReap(sessionReapCommand(sid, signal), sid, signal)
  }

  async function runReap(command: string, pid: number, signal?: number): Promise<KillOutcome> {
    try {
      const walk = await sandbox.commands.run(command, { background: true, timeoutMs: KILL_WALK_TIMEOUT_MS })
      const { exitCode } = await walk.wait()
      if (exitCode !== 0) {
      // The walk ends in `|| true`, so anything but `0` means it did not run to the end —
      // e2b stopping it at `KILL_WALK_TIMEOUT_MS` being the case that matters. Read from
      // the result rather than left to the SDK's non-zero-exit throw, so a timeout cannot
      // arrive here as a success and skip the fallback (cubic review, PR #260).
        throw new Error(`kill walk exited ${String(exitCode)}`)
      }
      return 'reaped'
    }
    catch (cause) {
      console.warn(`sandbox-e2b: the kill walk for pid ${pid} did not complete: ${String(cause)}`)
      // e2b's own kill is SIGKILL and nothing else ("It uses SIGKILL" — its `index.d.ts`), so
      // it can only stand in for the signal that was asked for when that signal *was* SIGKILL.
      // Substituting it for a SIGINT would cut the turn with no `result` — precisely what the
      // interrupt stage is for — so a gentler request is left unsent and reported as such.
      if (signal !== undefined && signal !== SIGKILL) {
        console.warn(
          `sandbox-e2b: pid ${pid} was not signalled; e2b's kill is SIGKILL-only and`
          + ` the requested ${signalFlag(signal)} was not substituted`,
        )
        return 'walk-failed'
      }
      // Fall back to what e2b offers directly — it leaves the child running, but a shell that
      // is gone writes no exit record either way, and doing nothing here would leave both
      // alive. Reported as `'fallback'` rather than resolved like a completed reap, because
      // those are different states of the sandbox and the caller has to act on which it got.
      await sandbox.commands.kill(pid).catch(() => false)
      return 'fallback'
    }
  }

  /**
   * Reap by session where that is safe, and by the tree walk where it is not.
   *
   * The signal is the contract's number, spelled the way `kill`/`pkill` take it. Without one
   * this is the SIGKILL reap it has always been; with SIGINT the same walk asks each process
   * to finish instead — children first still, so a `claude` turn's own children hear it before
   * the turn does — and the caller's bounded wait decides whether that was honoured.
   */
  function reapCommand(pid: number, signal?: number): string {
    const target = String(pid)
    const sig = signalFlag(signal)
    return `reap() { for c in $(pgrep -P "$1" 2>/dev/null); do reap "$c"; done;`
      + ` kill -${sig} "$1" 2>/dev/null || true; }`
      + ` ; sid=$(ps -o sid= -p ${target} 2>/dev/null | tr -d ' ')`
      + ` ; if [ "$sid" = "${target}" ] ; then pkill -${sig} -s ${target} 2>/dev/null || true`
      + ` ; else reap ${target} ; fi`
  }

  /** The session reap on its own, for a leader that can no longer answer the `sid` test. */
  function sessionReapCommand(sid: number, signal?: number): string {
    return `pkill -${signalFlag(signal)} -s ${String(sid)} 2>/dev/null || true`
  }

  return {
    livenessOf,
    listedWrapper,
    recoveredProcesses,
    recoveredCommand,
    sessionSurvivors,
    confirmReaped,
    killTree,
    killSession,
  }
}
