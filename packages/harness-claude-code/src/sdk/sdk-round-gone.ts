import type { SandboxSession } from '@amond-ai/sandbox'
import type { HostReading } from '../outcome'
/**
 * Whether the turn host is gone, as a round that has no socket to it reads that.
 *
 * Moved out of `sdk-round.ts` when the answer stopped being a boolean. A round that lost its
 * socket abandons the turn on this reading, and two things about that were wrong: the reading
 * was thrown away, so a run that ended this way recorded a bare timeout with no cause, and one
 * reading was enough — while a backend's `/proc` probe reads an empty answer as gone (the native
 * backend's `readProbe`), so a single misread could have the round kill a host that was alive.
 * The reading now says which way the host was gone, and a gone reading is confirmed by a second
 * one before anything acts on it.
 */

/**
 * One probe of the host process: the way it is gone, or `undefined` while it runs.
 *
 * A probe that fails is not gone: a control-plane blip must not end a turn that is still running.
 */
export async function probeHost(session: SandboxSession, processId: string): Promise<HostReading | undefined> {
  try {
    const process = await session.getProcess(processId)
    if (!process) {
      return { process: 'unknown-to-sandbox' }
    }
    const status = await process.status()
    switch (status.state) {
      case 'running':
        return undefined
      case 'exited':
        return { process: 'exited', exitCode: status.exit.code }
      default:
        // Read defensively: a backend's state outside the contract is still a non-running one.
        return (status as { error?: { code?: unknown } }).error?.code === 'no_exit_record'
          ? { process: 'no-exit-record' }
          : { process: 'not-running' }
    }
  }
  catch {
    return undefined
  }
}

/**
 * The host's reading, confirmed: two consecutive gone readings a `pause` apart, or `undefined`.
 *
 * Both readings must be gone; their kinds may differ (unknown to the sandbox, then exited). The
 * second reading is the one returned — it is the later, and the one an abandonment acts on —
 * except when the first carried an exit code and the second does not: a container reclaimed
 * during the pause reads unknown-to-sandbox, and the code (an OOM's 137) is the evidence a lost
 * host is recorded for, so the first reading is kept. A second probe that finds the host running
 * hands the round back to its dial loop exactly as a first one would have. `pause` is the round's
 * own reconnect backoff, on its injected `sleep`, so a test drives the gap rather than waiting it out.
 */
export async function confirmedHostLoss(
  session: SandboxSession,
  processId: string,
  pause: () => Promise<void>,
): Promise<HostReading | undefined> {
  const first = await probeHost(session, processId)
  if (first === undefined) {
    return undefined
  }
  await pause()
  const second = await probeHost(session, processId)
  return second !== undefined && first.exitCode !== undefined && second.exitCode === undefined ? first : second
}
