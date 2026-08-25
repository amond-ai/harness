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
import { ARGV_CLOSE, ARGV_OPEN, isProcessId, STDOUT_SUFFIX } from './journal'
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
  killTree: (pid: number) => Promise<void>
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
    const closed = commandLine.lastIndexOf(ARGV_CLOSE)
    if (closed < 0) {
      return undefined
    }
    const path = unquoteFirstArg(commandLine.slice(closed + ARGV_CLOSE.length))?.value
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
    const opened = commandLine.indexOf(ARGV_OPEN)
    const closed = commandLine.lastIndexOf(ARGV_CLOSE)
    return opened >= 0 && closed > opened ? commandLine.slice(opened + ARGV_OPEN.length, closed) : undefined
  }

  /**
   * Kill the wrapped command and everything under it, not just the shell e2b tracks.
   *
   * `journalledCommand` wraps the argv in a shell so `$?` can be journalled, so the pid e2b
   * tracks is that shell. `commands.kill` sends `SIGKILL`, which a shell can neither trap nor
   * propagate — measured (`scripts/spike-e2b-kill-tree.ts`, 2026-08-25): the `claude` child
   * was reparented to init, ran to completion, and no exit file was ever written. The
   * workflow then reads `no_exit_record`, settles the run failed, and retries into a checkout
   * a live agent is still writing to (codex review, PR #260).
   *
   * A process-group kill is not the way out: the same measurement shows every e2b command
   * shares PGID/SID `511`, so `kill -- -<pgid>` takes down the killing command and the rest
   * of the sandbox with it. Walking the tree children-first is scoped to exactly this
   * command — and children-first matters, because a parent killed before its children leaves
   * them reparented to init and out of reach.
   *
   * Awaited to completion, not merely started. e2b returns from a background command as soon
   * as it starts, and two callers here — `materializationExit` and the meta-write failure
   * path — surface a retry the moment this resolves: without the wait, the next `git clone`
   * would race a process tree that is still being killed in the same checkout (codex and
   * cubic reviews, PR #260).
   */
  async function killTree(pid: number): Promise<void> {
    const reap = `reap() { for c in $(pgrep -P "$1" 2>/dev/null); do reap "$c"; done;`
      + ` kill -KILL "$1" 2>/dev/null || true; }; reap ${pid}`
    try {
      const walk = await sandbox.commands.run(reap, { background: true, timeoutMs: KILL_WALK_TIMEOUT_MS })
      const { exitCode } = await walk.wait()
      if (exitCode !== 0) {
      // The walk ends in `|| true`, so anything but `0` means it did not run to the end —
      // e2b stopping it at `KILL_WALK_TIMEOUT_MS` being the case that matters. Read from
      // the result rather than left to the SDK's non-zero-exit throw, so a timeout cannot
      // arrive here as a success and skip the fallback (cubic review, PR #260).
        throw new Error(`kill walk exited ${String(exitCode)}`)
      }
    }
    catch (cause) {
    // The walk could not start, or did not finish. Fall back to what e2b offers directly —
    // it leaves the child running, but a shell that is gone writes no exit record either
    // way, and doing nothing here would leave both alive.
      console.warn(`sandbox-e2b: the kill walk for pid ${pid} did not complete: ${String(cause)}`)
      await sandbox.commands.kill(pid).catch(() => false)
    }
  }

  return { livenessOf, listedWrapper, recoveredProcesses, recoveredCommand, killTree }
}
