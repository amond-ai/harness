/**
 * Ending a turn — the whole group of it, and never through `Command.kill`.
 *
 * `Command.kill` signals what Vercel tracks, and under `setsid --wait sh -c '<script>'` that is
 * the process the API started, not the shell doing the journalling and not the agent. The e2b
 * backend measured what a SIGKILL there does (`wrapper-table.ts:342-356`,
 * `scripts/spike-e2b-kill-tree.ts`): the `claude` child was reparented to init, ran to
 * completion, and **no exit file was ever written** — so the workflow read `no_exit_record`,
 * settled the run as failed, and retried into a checkout a live agent was still writing to. The
 * same shape applies here for the same reason, so every kill this module sends is a `kill(1)`
 * *inside* the sandbox, aimed at a pid or a group the wrapper wrote down itself.
 *
 * Signals are sent through `sh -c` rather than as a `kill` executable, for the reason the probe
 * prefers `kill -0` to `pgrep`: `kill` is a shell builtin and is in every image, while
 * `/bin/kill` is util-linux and the sandbox image is not obliged to carry it. A kill that cannot
 * find its binary is a silent no-op, which is the one thing the contract forbids outright.
 *
 * Signal names are `kill(1)`'s spelling, not Vercel's `Signal` union: this runs in the sandbox's
 * shell, and what the API would accept is not what `kill` parses.
 */
import type { JournalMeta } from './journal'
import type { JournalIo } from './journal-io'
import type { JournalProbe } from './vercel-probe'
import type { VercelCommandLike, VercelSandboxLike } from './vercel-surface'
import { journalPaths, WRAPPER_SHELL } from './journal'

/**
 * The contract's signal numbers, as `kill(1)` spells them.
 *
 * Numbers would mostly work and are not portable: signal *numbers* differ between architectures
 * while the names do not, and a `kill -9` that landed as a different signal on an arm image
 * would be a kill nobody could account for. An unlisted number is passed through as itself
 * rather than mapped to a default — the contract forbids substituting a harsher signal, and
 * guessing is how that happens.
 */
const SIGNAL_NAMES: Record<number, string> = { 2: 'INT', 9: 'KILL', 15: 'TERM' }

export interface VercelKillOptions {
  /** Commands this isolate started, keyed by process id — see {@link JournalProbeOptions}. */
  execCommands?: Map<string, VercelCommandLike>
}

export type KillPath = (meta: JournalMeta, signal?: number) => Promise<void>

export function createVercelKill(
  sandbox: VercelSandboxLike,
  root: string,
  io: JournalIo,
  probe: JournalProbe,
  options: VercelKillOptions = {},
): KillPath {
  /** Run one `kill` in the sandbox's shell, and report only whether it was accepted. */
  async function shellKill(expression: string): Promise<boolean> {
    const ran = await sandbox.runCommand({ cmd: WRAPPER_SHELL, args: ['-c', `kill ${expression}`] })
    return ran.exitCode === 0
  }

  /**
   * After a default kill, say whether the tree actually died — and refuse to claim it did.
   *
   * Modelled on `wrapper-table.ts:334-340`. Resolving as though the tree had been reaped is what
   * `killTurn` reads as a confirmed kill, after which it starts the next attempt in the same
   * checkout. Only an *observed* survivor throws: a probe that could not run has measured
   * nothing, and failing every kill against an unreachable sandbox is not what it learned. The
   * caller catches, re-reads `status()`, and reports the kill unconfirmed.
   */
  async function confirmReaped(meta: JournalMeta, via: string): Promise<void> {
    const reading = await probe.read(meta)
    console.warn(`sandbox-vercel: kill of '${meta.id}' went through ${via}; group ${reading.group}`)
    if (reading.liveness === 'live') {
      throw new Error(`kill of '${meta.id}' left processes running in its group`)
    }
  }

  /** The SDK handle for this process, when there is still one to be had. */
  async function warmCommand(meta: JournalMeta): Promise<VercelCommandLike | undefined> {
    const started = options.execCommands?.get(meta.id)
    if (started) {
      return started
    }
    if (meta.cmdId === '' || meta.sessionId !== sandbox.sessionId()) {
      return undefined
    }
    try {
      return await sandbox.getCommand(meta.cmdId)
    }
    catch {
      return undefined
    }
  }

  /**
   * The last resort for a default kill with no pid to aim at.
   *
   * `Command.kill` is what this module exists to avoid, and it is still better than nothing
   * here: it ends the `setsid` process, which is at least the head of the tree, where sending
   * nothing ends nothing at all. It is reported as **partial** rather than as a kill, because
   * that is exactly what it is — the measured outcome is a reparented child that keeps running —
   * and a caller that read it as confirmed would do the thing this whole file prevents.
   *
   * Cold — no handle, because the session moved on — sends nothing and says so. The contract is
   * explicit that a backend which cannot deliver must neither do nothing silently nor substitute
   * a harsher signal; the log is the "neither silently" half, and the caller's bounded wait is
   * what escalates.
   */
  async function killWithoutPid(meta: JournalMeta): Promise<void> {
    const command = await warmCommand(meta)
    if (command === undefined) {
      console.warn(
        `sandbox-vercel: no pid recorded for '${meta.id}' and no live command handle;`
        + ' the kill was not delivered',
      )
      return
    }
    await command.kill('SIGKILL')
    console.warn(
      `sandbox-vercel: no pid recorded for '${meta.id}'; killed the tracked command only.`
      + ' This is a partial kill — anything it started may still be running',
    )
  }

  return async (meta, signal) => {
    const paths = journalPaths(root, meta.id)

    if (signal !== undefined) {
      // The process, never the group. SIGINT is how `claude` is asked to end the turn and still
      // print its `result`, and broadcasting it to the group would reach the wrapper shell,
      // which dies on it without running the `printf` that records the exit: the turn would end
      // with neither the result nor the exit code the interrupt exists to collect.
      const pid = await io.readPid(paths.pid)
      if (pid === undefined) {
        // Deliberately *not* the warm fallback below. That one sends SIGKILL, and substituting
        // it for a named signal is the harsher substitution the contract forbids by name — a
        // SIGKILL sent where SIGINT was asked for ends the turn without the `result`.
        console.warn(
          `sandbox-vercel: no pid recorded for '${meta.id}'; signal ${String(signal)} was not delivered`,
        )
        return
      }
      if (!await shellKill(`-${SIGNAL_NAMES[signal] ?? String(signal)} ${String(pid)}`)) {
        console.warn(`sandbox-vercel: signal ${String(signal)} to '${meta.id}' (pid ${String(pid)}) was refused`)
      }
      return
    }

    // The default kill reaps the group, which under `setsid` is the turn and everything it
    // started — the `git`, `bun` and language servers a pid kill would leave behind.
    const group = await io.readPid(paths.pgid)
    if (group !== undefined && await shellKill(`-KILL -- -${String(group)}`)) {
      await confirmReaped(meta, `group -${String(group)}`)
      return
    }

    // Strictly narrower than what was asked for, so it can never exceed the request: a group
    // kill that was refused — a group that is already empty, or a pgid the wrapper never got to
    // write — still leaves the command's own pid worth signalling.
    const pid = await io.readPid(paths.pid)
    if (pid === undefined) {
      await killWithoutPid(meta)
      return
    }
    if (!await shellKill(`-KILL ${String(pid)}`)) {
      console.warn(`sandbox-vercel: SIGKILL to '${meta.id}' (pid ${String(pid)}) was refused`)
    }
    await confirmReaped(meta, `pid ${String(pid)}`)
  }
}
