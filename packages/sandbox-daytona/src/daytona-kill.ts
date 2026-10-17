/**
 * Signalling a turn, on a platform with no signal API.
 *
 * Daytona's session surface is create/delete session, execute, logs, send-input — there is no
 * kill and no pid (research note 035 §3). So a kill is an ordinary `kill(1)` run beside the turn
 * through `executeCommand`, aimed at the pid the wrapper recorded in `<stateRoot>/<id>.pid`.
 *
 * **Read from the file, never from a cache.** The provider that kills is routinely not the one
 * that started the turn: `run-workflow.ts` retries a step on another instance, and the watchdog's
 * kill arrives through a `getProcess(id)` on a cold session. An in-memory pid would be absent
 * exactly when the kill matters, so the file is the source of truth and the extra read is the
 * price.
 *
 * **The default kill takes the group, a named one takes the process.** `wrappedCommand` runs the
 * turn under `setsid`, so the recorded pid is also the process-group id and `kill -KILL -- -<pid>`
 * reaches the children a turn spawned — a `claude` turn's `git`, its `bun`, its language servers.
 * A caller that names a signal is asking something of the *process*: the contract's own example
 * is SIGINT, which the `claude` CLI answers by ending the turn and printing its `result`, and
 * broadcasting that to a group would interrupt every child instead.
 *
 * **A recorded pid is checked before it is signalled.** After a sandbox restart the file can
 * outlive the process, and the number can belong to anything. The wrapper records the boot id and
 * the process's start time beside the pid; a kill re-reads both and treats a mismatch as the
 * process being already gone — nothing is signalled, and no harsher lever is pulled in its place.
 * A bare pid (no `/proc` where it was written) cannot be checked and is trusted as before.
 *
 * **Non-delivery is reported, never substituted.** The contract forbids answering a named signal
 * with a harsher one, so an unreadable pid file ends a named kill with a warning and nothing
 * else; the caller's bounded wait then times out and escalates to the default kill, which is the
 * ladder `killTurn` already climbs. Only the default kill has a fallback, and it is
 * `deleteSession` — Daytona's one remaining lever over a session whose pid was never recorded.
 */
import type { DaytonaSandboxLike } from './daytona-surface'
import { identityCheck, parsePidRecord, processPaths } from './daytona-process'

/** `kill -KILL` for the default, which is what the e2b backend's tree walk sends too. */
const DEFAULT_SIGNAL = 'KILL'

export interface KillPath {
  killProcess: (processId: string, signal?: number) => Promise<void>
}

export function createKillPath(sandbox: DaytonaSandboxLike, root: string): KillPath {
  /** The pid the wrapper recorded and who it was then, or `undefined` if nothing readable is there. */
  async function recordedPid(processId: string): Promise<ReturnType<typeof parsePidRecord> | undefined> {
    let bytes: Uint8Array
    try {
      bytes = await sandbox.fs.downloadFile(processPaths(root, processId).pid)
    }
    catch {
      // Absent, unreadable, or a transport failure — all the same to a kill, which has no other
      // way to name the process either way. The caller is told which lever was pulled instead.
      return undefined
    }
    const record = parsePidRecord(new TextDecoder().decode(bytes))
    return Number.isSafeInteger(record.pid) && record.pid > 1 ? record : undefined
  }

  /** Is the recorded pid still the process the wrapper started? Unproven identity is not a no. */
  async function stillRecorded(pid: number, identity: ReturnType<typeof parsePidRecord>['identity']): Promise<boolean> {
    if (identity === undefined) {
      return true
    }
    return (await sandbox.process.executeCommand(identityCheck(pid, identity))).exitCode === 0
  }

  async function killGroup(pid: number): Promise<void> {
    const group = await sandbox.process.executeCommand(`kill -${DEFAULT_SIGNAL} -- -${String(pid)}`)
    if (group.exitCode === 0) {
      return
    }
    // A group kill fails where the pid does not lead one — a sandbox image without `setsid`, or
    // a turn already reaped down to a reparented child. Falling back to the process itself is
    // strictly narrower than what was asked for, so it can never exceed the caller's request.
    const single = await sandbox.process.executeCommand(`kill -${DEFAULT_SIGNAL} ${String(pid)}`)
    if (single.exitCode !== 0) {
      console.warn(
        `daytona kill fell through process=${pid} group_exit=${group.exitCode} `
        + `process_exit=${single.exitCode}`,
      )
    }
  }

  return {
    killProcess: async (processId, signal) => {
      const recorded = await recordedPid(processId)
      const pid = recorded?.pid
      if (recorded === undefined || pid === undefined) {
        if (signal !== undefined) {
          // Never a harsher substitute: the caller wanted this process to end on its own terms,
          // and `deleteSession` is not that. Reported so the sandbox surfaces the non-delivery.
          console.warn(`daytona cannot deliver signal ${signal} to '${processId}': no recorded pid`)
          return
        }
        console.warn(`daytona has no recorded pid for '${processId}'; deleting its session instead`)
        await sandbox.process.deleteSession(processId)
        return
      }
      if (!await stillRecorded(pid, recorded.identity)) {
        // Another boot or another process under the same number: ours is already gone, and the
        // sweep that asked wants exactly that answer rather than an error.
        console.warn(`daytona pid ${pid} for '${processId}' is no longer the process it started; not signalling`)
        return
      }
      if (signal !== undefined) {
        const sent = await sandbox.process.executeCommand(`kill -${String(signal)} ${String(pid)}`)
        if (sent.exitCode !== 0) {
          // The pid was readable but `kill` did not land — the process is already gone, or it is
          // not ours to signal. Same non-delivery as an unreadable pid file, so it is reported the
          // same way and nothing harsher is put in its place.
          console.warn(
            `daytona could not deliver signal ${signal} to process=${pid} exit=${sent.exitCode}`,
          )
        }
        return
      }
      await killGroup(pid)
    },
  }
}
