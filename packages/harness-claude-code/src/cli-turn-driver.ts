/**
 * The `cli` driver: a turn is the `claude` CLI exec'd in the sandbox, watched by sampling its
 * log cursor and stopped with SIGINT.
 *
 * This is the incumbent path moved behind {@link TurnDriver} unchanged — the process resource
 * Sandbox 1.0 retains for the container's lifetime is still what the Agent replays afterwards
 * (AC-002), and every threshold, ordering and log line is the one `run-workflow.ts` had.
 *
 * It is given a `SandboxProvider` and an id rather than a session, and resolves the session
 * *inside* every operation. That is the contract's own rule (`SandboxProvider`: "the
 * orchestrator calls it per use rather than holding a session across a workflow step, because a
 * Durable Object stub does not survive a step boundary"), and it is what makes the driver safe
 * to cache: start, await and kill are three separate steps, and a session captured at
 * construction would be the same stub in all three. Which backend it resolves to stays
 * `SANDBOX_BACKEND`'s question, so the driver is still orthogonal to it.
 */
import type { SandboxProvider, SandboxSession } from '@amond-ai/sandbox'
import type { AttemptResult, ClaudeArgv, TurnAwaitSpec, TurnDriver, TurnHandle, TurnStartSpec } from './turn-driver'
import { isLive, killTurn } from './cli-turn-kill'
import { awaitTurn } from './cli-turn-watch'

export function cliTurnDriver(
  provider: SandboxProvider,
  sandboxId: string,
  claudeArgv: (turn: TurnStartSpec) => ClaudeArgv,
): TurnDriver {
  return {
    mode: 'single',

    async start(turn: TurnStartSpec): Promise<TurnHandle> {
      // Refused rather than ignored, and refused without calling it: there is no `--resume` on
      // this path — the CLI turn is a fresh process given a prompt — so a driver that dropped
      // the thunk would start an unrelated session while the attempt loop believed it had
      // carried the previous attempt's context across. `run-workflow.ts` builds one only under
      // `turnDriver === 'sdk'`, so reaching here at all means the two disagree about which
      // driver is running.
      if (turn.resume !== undefined) {
        throw new Error('the cli driver cannot resume a session')
      }
      const sandbox = provider.session(sandboxId)
      // Built from the whole spec by the caller's builder, and built *here* rather than passed
      // in already assembled: the prompt reaches this driver as argv and the `sdk` driver as a
      // frame, and the reuse guard below compares that argv exactly — so the command and the
      // thing that matches it are one decision, made once, at the moment the turn starts.
      const command = claudeArgv(turn)
      const live = await liveTurnProcess(sandbox, command, turn.recordedProcessId, turn.started)
      if (live) {
        // Later than the adopted process really started, by however long the workflow was away.
        // Generous but bounded — the adopted turn gets at most one extra budget's grace and never
        // an unbounded one, which is the direction to err in when the alternative is killing a
        // healthy turn on a clock nobody can re-read.
        return { processId: live, startedAtMs: Date.now() }
      }
      await turn.beforeExec?.()
      const process = await sandbox.exec(command, { cwd: turn.cwd, env: turn.env() })
      return { processId: process.id, startedAtMs: Date.now() }
    },

    async await(handle: TurnHandle, spec: TurnAwaitSpec): Promise<AttemptResult> {
      return await awaitTurn(provider.session(sandboxId), handle.processId, spec.config, {
        mirror: spec.mirror,
        startedAtMs: handle.startedAtMs,
      })
    },

    async kill(handle: TurnHandle): Promise<boolean> {
      return await killTurn(provider.session(sandboxId), handle.processId)
    },
  }
}

/** Compare argv exactly: executable, argument order, and every literal argument. */
function sameCommand(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

/**
 * The idempotency guard: the id of a live turn for this run, if one exists. Processes
 * this workflow already started are excluded, so a killed-but-not-yet-reaped turn from a
 * previous attempt cannot be adopted as the next one.
 */
async function liveTurnProcess(
  sandbox: SandboxSession,
  command: ClaudeArgv,
  recordedId: string | undefined,
  started: readonly string[],
): Promise<string | undefined> {
  if (recordedId) {
    const handle = await sandbox.getProcess(recordedId)
    if (handle && isLive(await handle.status())) {
      return handle.id
    }
  }
  const processes = await sandbox.listProcesses()
  return processes.find(process =>
    isLive(process) && sameCommand(process.command, command) && !started.includes(process.id))?.id
}
