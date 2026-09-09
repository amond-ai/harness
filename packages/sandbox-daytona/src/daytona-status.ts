/**
 * What Daytona can be asked about a process, and what its answers mean.
 *
 * This is the module the whole backend's thinness rests on. The e2b backend has to cross-check a
 * journal file the turn can write against a process table the turn cannot, because e2b forgets a
 * command the moment it exits. Daytona's toolbox daemon does not forget: `getSessionCommand`
 * still answers with the command's `exitCode` after it has finished, and the daemon is what wrote
 * that code — the turn has no way to put a number there. So one read settles liveness *and* exit,
 * and there is no forgery to defend against.
 *
 * Three verdicts, and the third is the one that needs stating. A session Daytona 404s on is not
 * an exit: nothing recorded how the command ended, which the contract already has a name for
 * (`SandboxNoExitRecordError`, `no_exit_record`). It is reachable — a sandbox stopped and
 * restarted is not documented to keep its sessions (research note 035 §3), and this is what that
 * looks like from outside.
 */
import type { ProcessFailure } from '@amond-ai/sandbox'
import type { DaytonaSandboxLike, DaytonaSessionLogs } from './daytona-surface'
import { isNotFound } from './daytona-surface'

/** Named once so a caller meets one vocabulary for one condition, whichever surface it asked. */
export const NO_EXIT_RECORD: ProcessFailure = {
  code: 'no_exit_record',
  message: 'process is not running and its session recorded no exit code',
}

export type CommandVerdict
  = | { kind: 'running' }
    | { kind: 'exited', code: number }
    /** The session, or its command, is not there — so nothing recorded how it ended. */
    | { kind: 'gone' }

export interface CommandReader {
  /** Remember the command a freshly started session runs, so the next read costs one call. */
  remember: (processId: string, commandId: string) => void
  verdict: (processId: string) => Promise<CommandVerdict>
  /** The command's retained stdout/stderr, or empty streams once the session is gone. */
  logs: (processId: string) => Promise<DaytonaSessionLogs>
}

/**
 * Reads a process's command through its session, memoising the command id.
 *
 * The id is recoverable from nothing but the process id — `getSession(id).commands[0].id` — which
 * is what lets a *cold* provider answer `getProcess(id)`. The memo only spares the second call
 * from paying for it: a retried workflow step runs on another instance with an empty map, and
 * that path has to keep working, so nothing here may depend on the memo being warm.
 */
export function createCommandReader(sandbox: DaytonaSandboxLike): CommandReader {
  const commandIds = new Map<string, string>()

  async function commandId(processId: string): Promise<string | undefined> {
    const cached = commandIds.get(processId)
    if (cached !== undefined) {
      return cached
    }
    let session
    try {
      session = await sandbox.process.getSession(processId)
    }
    catch (cause) {
      // Only a 404 is an absence. A transport failure must not become "the process is gone",
      // which every caller downstream reads as a confirmed death.
      if (isNotFound(cause)) {
        return undefined
      }
      throw cause
    }
    // One session per process, so the turn is `commands[0]`. A session with none is one whose
    // command never started — indistinguishable from gone, and treated as it.
    const found = session.commands[0]?.id
    if (found !== undefined) {
      commandIds.set(processId, found)
    }
    return found
  }

  return {
    remember: (processId, id) => {
      commandIds.set(processId, id)
    },
    verdict: async (processId) => {
      const id = await commandId(processId)
      if (id === undefined) {
        return { kind: 'gone' }
      }
      let command
      try {
        command = await sandbox.process.getSessionCommand(processId, id)
      }
      catch (cause) {
        if (isNotFound(cause)) {
          return { kind: 'gone' }
        }
        throw cause
      }
      // The daemon writes `exitCode` when the command finishes and leaves it unset until then,
      // so its presence *is* the exit — no second opinion needed, and none available.
      return command.exitCode === undefined ? { kind: 'running' } : { kind: 'exited', code: command.exitCode }
    },
    logs: async (processId) => {
      const id = await commandId(processId)
      if (id === undefined) {
        return {}
      }
      try {
        return await sandbox.process.getSessionCommandLogs(processId, id)
      }
      catch (cause) {
        if (isNotFound(cause)) {
          return {}
        }
        throw cause
      }
    },
  }
}
