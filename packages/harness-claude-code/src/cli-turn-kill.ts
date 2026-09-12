/**
 * Stopping a `cli` turn: SIGINT first, the backend's default kill on escalation, and the
 * re-check that decides whether another attempt may safely start.
 *
 * Split from the driver so the escalation ladder reads as one thing. {@link isLive} lives here
 * rather than beside the adoption guard that also uses it, because the guard's module imports
 * this one and the reverse import would close a cycle.
 */
import type { ProcessStatus, SandboxProcessHandle, SandboxSession } from '@amond-ai/sandbox'
import { describeCause as describe } from '@amond-ai/redact'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '@amond-ai/sandbox'

/**
 * Bounds the post-kill network wait without consuming active CPU. The observation timeout
 * cancels only the wait, not the process; a status re-check decides whether retry is safe.
 */
export const KILL_SETTLE_TIMEOUT_MS = 5_000

/**
 * Bounds the wait for the CLI to finish on its own after the interrupt. Longer than
 * {@link KILL_SETTLE_TIMEOUT_MS} because this stop is meant to *succeed*: on SIGINT the
 * `claude` CLI ends the in-flight turn and prints its `result` line before exiting, whereas
 * SIGTERM exits 143 with the turn unfinished and no `result` at all (headless docs, "Stop a run
 * with SIGTERM"; ADR "turns run through the Agent SDK in a turn host", phase 0). Escalating
 * before the CLI has had time to write that line would throw away the one thing the interrupt
 * exists to keep.
 */
export const INTERRUPT_SETTLE_TIMEOUT_MS = 15_000

/** POSIX SIGINT: the signal the `claude` CLI answers by ending the turn with a `result`. */
const SIGINT = 2

/** Sandbox 1.0 has one live lifecycle state; every other state is terminal. */
export function isLive(status: ProcessStatus): boolean {
  return status.state === 'running'
}

/**
 * Best-effort stop, with its success made observable rather than discarded.
 *
 * Two stages. SIGINT first: the CLI answers it by ending the in-flight turn and printing its
 * `result` line, so the transcript ends in the agent's own last word and the replay can read
 * the outcome (ADR phase 0). Unless that wait proves the turn already gone, {@link terminateTurn}
 * escalates to the backend's default kill — today's SIGTERM, which cuts the turn with no `result`.
 *
 * Each stage races the turn's own exit. After signalling, a bounded network wait observes
 * settlement; if it times out, the process status is re-checked. A failed kill must not
 * fail this NO_RETRIES step: the verdict is already timeout, but the caller must still know
 * whether starting another attempt is safe. A missing process or a non-running status
 * confirms death; an unhealthy re-check remains unconfirmed (PR-72 review — 718f46c regression).
 */
export async function killTurn(sandbox: SandboxSession, processId: string): Promise<boolean> {
  try {
    const process = await sandbox.getProcess(processId)
    if (!process) {
      return true
    }
    try {
      await process.kill(SIGINT)
    }
    catch (cause) {
      // The interrupt never left: a backend that cannot send a named signal, or a transient
      // control failure. Liveness is exactly as unknown as after an unsettled interrupt, so the
      // same escalation applies — falling through to the outer catch would skip the default
      // kill and leave the turn running until the sandbox expires (Codex review, PR #372).
      console.warn(`watchdog interrupt request failed process_id=${processId} error="${describe(cause)}"; escalating to kill`)
      return await terminateTurn(sandbox, process, processId)
    }
    try {
      await process.waitForExit({ timeout: INTERRUPT_SETTLE_TIMEOUT_MS })
      return true
    }
    catch (cause) {
      // Only a proven death skips the escalation. `SandboxNoExitRecordError` is that proof —
      // the turn is gone, it just never recorded `$?` — and a second signal at a dead process
      // confirms nothing. Everything else leaves liveness unknown and must escalate, as the
      // pre-phase-0 code did unconditionally: the contract's two error classes are explicitly
      // not an exhaustive union (`packages/amond-ai/sandbox/src/types.ts`), and the default
      // Cloudflare backend rejects with `@cloudflare/sandbox`'s own `ProcessWaitTimeoutError`,
      // which is neither of them — gating on `SandboxWaitTimeoutError` left every production
      // interrupt at SIGINT, never terminating a wedged turn.
      if (cause instanceof SandboxNoExitRecordError) {
        logKillSettle(processId, cause)
        return await confirmDead(sandbox, processId)
      }
      const settle = cause instanceof SandboxWaitTimeoutError
        ? `after_ms=${cause.elapsedMs}`
        : `error="${describe(cause)}"`
      console.warn(`watchdog interrupt did not settle process_id=${processId} ${settle}; escalating to kill`)
      return await terminateTurn(sandbox, process, processId)
    }
  }
  catch (cause) {
    console.warn(`watchdog kill failed process_id=${processId} error="${describe(cause)}"`)
    return await confirmDead(sandbox, processId)
  }
}

/** The escalation: the backend's default kill, settled inside {@link KILL_SETTLE_TIMEOUT_MS}. */
async function terminateTurn(
  sandbox: SandboxSession,
  process: SandboxProcessHandle,
  processId: string,
): Promise<boolean> {
  await process.kill()
  try {
    await process.waitForExit({ timeout: KILL_SETTLE_TIMEOUT_MS })
    return true
  }
  catch (cause) {
    logKillSettle(processId, cause)
    return await confirmDead(sandbox, processId)
  }
}

/**
 * The ordinary ending, not the exceptional one: the journal wrapper is a single shell script
 * whose trailing `printf '%s' "$?"` a stop usually pre-empts, so the wait ends with no exit
 * record almost immediately. Logging that as a slow settle mislabels the common case. A
 * `SandboxWaitTimeoutError` is the genuinely slow one — the signal was not observed to take
 * effect inside the budget — and is the only rejection that says so.
 */
function logKillSettle(processId: string, cause: unknown): void {
  if (cause instanceof SandboxWaitTimeoutError) {
    console.warn(`watchdog kill settle timed out process_id=${processId} after_ms=${cause.elapsedMs}`)
  }
  else if (cause instanceof SandboxNoExitRecordError) {
    console.warn(`watchdog kill settled without an exit record process_id=${processId}`)
  }
  else {
    console.warn(`watchdog kill settled without an exit record process_id=${processId} error="${describe(cause)}"`)
  }
}

/** Re-read after a failed kill: anything short of a definite "gone" counts as unconfirmed. */
async function confirmDead(sandbox: SandboxSession, processId: string): Promise<boolean> {
  try {
    const process = await sandbox.getProcess(processId)
    return !process || !isLive(await process.status())
  }
  catch (cause) {
    console.warn(`watchdog kill re-check failed process_id=${processId} error="${describe(cause)}"`)
    return false
  }
}
