/*
 * The kill path, and the pid it is allowed to aim by.
 *
 * Split out of `e2b-session.ts` so that one file is not both the journal-backed process
 * surface and the reasoning about which pid may be trusted to name a target. Nothing here
 * touches the journal: it is handed the wrapper table's primitives and a per-session memory of
 * what this isolate started.
 */

import type { JournalMeta } from './journal'
import type { KillOutcome, SessionSurvivors } from './wrapper-table'
import { signalFlag } from './wrapper-table'

/** The wrapper-table calls the kill path needs, named so a test can stand in for them. */
export interface KillPathDeps {
  listedWrapper: (id: string) => Promise<{ pid?: number } | undefined>
  killTree: (pid: number, signal?: number) => Promise<KillOutcome>
  killSession: (sid: number, signal?: number) => Promise<KillOutcome>
  confirmReaped: (id: string, pid: number, via: string) => Promise<void>
  sessionSurvivors: (sid: number) => Promise<SessionSurvivors>
}

export interface KillPath {
  /** Record what `exec` started, so a later `getProcess` handle can still aim at it. */
  rememberExecPid: (id: string, pid: number) => void
  /** Drop a pid once the process is proven gone; see {@link KillPath.rememberExecPid}. */
  forgetExecPid: (id: string) => void
  /** The session id the death proofs ask about. */
  sessionPid: (meta: JournalMeta) => number
  /** Stop one process, by its wrapper where e2b still lists one and by its session where not. */
  killProcess: (meta: JournalMeta, signal?: number) => Promise<void>
}

export function createKillPath(deps: KillPathDeps): KillPath {
  const { confirmReaped, killSession, killTree, listedWrapper, sessionSurvivors } = deps

  /**
   * Exec-time pids, by process id — the only pids this session will aim a kill by on its own.
   *
   * `meta.pid` is read back from `<id>.meta.json`, a file inside the sandbox that the turn can
   * rewrite, so it cannot pick a kill target. This map is written once, host-side, from what
   * `commands.run` returned, and is never read from disk. The run workflow reaches its handles
   * through `getProcess` rather than holding the one `exec` returned (`killTurn` and
   * `terminateTurn` in `run-workflow.ts`), so the trust has to survive that lookup — which is
   * what this map is for, and the session outlives it because the provider caches one session
   * per sandbox id.
   */
  const execPids = new Map<string, number>()

  /**
   * A pid to aim a kill at when e2b lists no wrapper for the process.
   *
   * The wrapper's absence is not proof the turn is gone. A session-wide stop kills the
   * untrapped `sh` wrapper first, and `claude` — reparented to init — keeps running in the
   * same session, which is exactly the state `sessionSurvivors` was built to see. So when this
   * session started the process itself and its session still has survivors, that exec-time pid
   * is the session id `pkill -s` needs to reach the orphan.
   *
   * **The boundary is this isolate's memory, not anything persisted.** A process this session
   * did not start — a different isolate after a Durable Object restart, a handle rebuilt from
   * `recoveredProcesses()` or from the journal files alone — has no entry here and gets no
   * target, because the only pid left for it is the turn's own to choose.
   */
  async function orphanedSessionPid(meta: JournalMeta): Promise<number | undefined> {
    // `1` is init, whose session holds the whole container: `pkill -s 1` would take it down.
    // No wrapper is ever pid 1 (envd started it), so refusing it costs nothing.
    const pid = execPids.get(meta.id)
    if (pid === undefined || pid <= 1) {
      return undefined
    }
    return await sessionSurvivors(pid) === 'survivors' ? pid : undefined
  }

  /**
   * The pid the death proofs ask about, which is not the pid a kill may be aimed by.
   *
   * `statusOf`, `waitForExit` and the log follow all decide a turn is *over* partly from
   * `sessionSurvivors`, and `run-workflow.ts` now treats `SandboxNoExitRecordError` as the one
   * proof that skips the SIGTERM escalation — so a turn that rewrote `<id>.meta.json` to
   * `pid: 0` (which `sessionSurvivors` short-circuits to `'none'`) could certify its own
   * death. The exec-time pid is preferred wherever this isolate has it. Unlike the kill path
   * it still falls back to `meta.pid`: a probe is read-only, and for a process this session
   * did not start the journal's pid is the only session id there is.
   */
  function sessionPid(meta: JournalMeta): number {
    return execPids.get(meta.id) ?? meta.pid
  }

  /**
   * Forget a process's exec-time pid once it is proven gone.
   *
   * Pids are recycled. An entry kept past the process's death is a `pkill -s` aimed at
   * whatever holds that number next, which on a busy sandbox is another turn's session. Only
   * a proof clears it: a journalled exit code, or gone-from-e2b with an empty session.
   *
   * Deliberately *not* cleared after a reap that merely ran. `killTurn` interrupts first and
   * escalates to the default kill when that does not settle; a SIGINT walk reports `'reaped'`
   * while the turn is still winding down, and dropping the pid there would leave the
   * escalation with nothing to aim at — the exact failure this map was added to fix.
   */
  function forgetExecPid(id: string): void {
    execPids.delete(id)
  }

  /**
   * Stop one wrapper and everything below it.
   *
   * `'fallback'` means e2b's own SIGKILL stood in for the walk, which leaves the wrapped
   * command running — so the session is probed before the kill may be called confirmed.
   * `'walk-failed'` means nothing was signalled at all (the requested signal was not SIGKILL
   * and e2b's kill sends only that), so there is nothing to confirm: the caller's bounded wait
   * times out and escalates, and that escalation is the kill that may fall back.
   */
  async function killProcess(meta: JournalMeta, signal?: number): Promise<void> {
    const listed = await listedWrapper(meta.id)
    if (listed?.pid !== undefined) {
      await settleKill(meta.id, listed.pid, await killTree(listed.pid, signal), signal, 'the tree walk')
      return
    }
    const orphan = await orphanedSessionPid(meta)
    if (orphan === undefined) {
      return
    }
    // The leader is gone, so the tree walk's own `sid = pid` gate can no longer pass and its
    // fallback walk would signal nothing while reporting a reap. The session is reaped
    // directly, and confirmed either way — this path only runs when survivors were seen, so
    // "did it work" is the whole question.
    const outcome = await killSession(orphan, signal)
    await settleKill(meta.id, orphan, outcome, signal, 'a session reap')
    if (outcome !== 'walk-failed') {
      await confirmReaped(meta.id, orphan, 'a session reap')
    }
  }

  /**
   * Say what the reap did, and confirm it where its outcome leaves the tree possibly alive.
   *
   * `'fallback'` means e2b's own SIGKILL stood in for the walk, which leaves the wrapped
   * command running — so the session is probed before the kill may be called confirmed.
   * `'walk-failed'` means nothing was signalled at all: e2b's kill sends only SIGKILL, so it
   * cannot stand in for a gentler request, and substituting it would end the turn without the
   * `result` the interrupt exists to collect. There is nothing to confirm then — the caller's
   * bounded wait times out and escalates, and that escalation is the kill that may fall back.
   * It is logged rather than swallowed so that timeout is diagnosable from the sandbox's own
   * output (`SandboxProcessHandle.kill` in `@pleaseai/sandbox-contract` says a backend that
   * cannot deliver a named signal must say so rather than silently do nothing).
   */
  async function settleKill(
    id: string,
    pid: number,
    outcome: KillOutcome,
    signal: number | undefined,
    via: string,
  ): Promise<void> {
    if (outcome === 'walk-failed') {
      console.warn(
        `sandbox-e2b: kill of '${id}' (pid ${String(pid)}, signal ${signalFlag(signal)})`
        + ` signalled nothing: ${via} did not complete and e2b's SIGKILL was not substituted`,
      )
      return
    }
    if (outcome === 'fallback') {
      await confirmReaped(id, pid, 'e2b\'s own kill')
    }
  }

  return {
    rememberExecPid: (id, pid) => {
      execPids.set(id, pid)
    },
    forgetExecPid,
    sessionPid,
    killProcess,
  }
}
