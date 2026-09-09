/**
 * What a process is, on Daytona: a session id, a wrapper script, and one meta file.
 *
 * The contract's process id *is* the Daytona session id — one session per process — so nothing
 * here has to reconcile two identities the way the e2b backend does. What it does have to supply
 * is the two things Daytona's session API does not carry: the pid of the command it started
 * (research note 035 §3 — `Command` is `{ id, command, exitCode? }` and nothing else), and the
 * argv/cwd a `ProcessStatus` must report.
 *
 * The pid comes out of the wrapper, written by the shell itself. The rest comes out of the meta
 * file, which is informational only: liveness and exit are read from the toolbox daemon, never
 * from a file the turn could write.
 */
import type { SandboxCommand } from '@amond-ai/sandbox'
import { quoteArg, quoteArgv } from './shell-quote'

/**
 * Ids that are safe to interpolate into a path and a command line.
 *
 * The same alphabet the e2b backend screens on, and screened for the same two reasons: an id
 * reaches `<stateRoot>/<id>.pid` as a path segment, and it reaches a shell as part of a quoted
 * word. `crypto.randomUUID()` is well inside it; a foreign session id in the sandbox is not
 * necessarily, which is what `listProcesses` uses this for.
 */
export function isProcessId(value: string): boolean {
  return /^[\w-]+$/.test(value)
}

export interface ProcessPaths {
  /** Where the wrapper records `$$`, so a cold provider can still aim a kill. */
  pid: string
  meta: string
}

export function processPaths(root: string, processId: string): ProcessPaths {
  if (!isProcessId(processId)) {
    throw new Error(`invalid process id '${processId}': expected [A-Za-z0-9_-]+`)
  }
  const base = root.replace(/\/+$/, '')
  return { pid: `${base}/${processId}.pid`, meta: `${base}/${processId}.meta.json` }
}

/** What the backend records about a process that Daytona's own session cannot answer. */
export interface ProcessMeta {
  id: string
  /** Non-empty by construction: a meta recording no command records nothing that ran. */
  command: SandboxCommand
  cwd?: string
  startedAt: string
}

/**
 * The command string a session runs, which is a wrapper rather than the argv itself.
 *
 * Three jobs, none of which Daytona does for us:
 *
 * 1. **`printf '%s' "$$"`** records the pid. There is no pid in the API and no signal API
 *    either, so a kill is an ordinary `kill(1)` and this file is the only thing that says what
 *    to aim it at. Written first, so it exists before the command can be worth killing.
 * 2. **`exec`** makes that pid the *command's* pid rather than a shell that will fork one.
 *    Without it the recorded pid names a parent, and a kill aimed at it leaves the turn running.
 * 3. **`setsid --wait`** puts the whole thing in a new session, so that pid is also the
 *    process-group id — which is what the default kill signals (`kill -KILL -- -<pid>`), and
 *    therefore what reaches a turn's children. `--wait` keeps the session's command alive for as
 *    long as the group is, so the daemon's exit code is the turn's rather than `setsid`'s.
 *
 * `cd` and `env` appear only when the caller asked for them. A Daytona session is one shell whose
 * cwd and environment persist across its commands, but there is exactly one command per session
 * here, so setting them per command is the same thing and needs no session-level bookkeeping.
 */
export function wrappedCommand(input: {
  command: SandboxCommand
  pidPath: string
  cwd?: string
  env?: Record<string, string>
}): string {
  const launch = ['exec']
  const env = Object.entries(input.env ?? {})
  if (env.length > 0) {
    // The whole `NAME=value` pair is quoted rather than the value alone: `env` takes it as one
    // word, and a name that is not a bare identifier would otherwise split the command line.
    launch.push('env', ...env.map(([name, value]) => quoteArg(`${name}=${value}`)))
  }
  launch.push(quoteArgv(input.command))
  const run = input.cwd === undefined ? launch.join(' ') : `cd ${quoteArg(input.cwd)} && ${launch.join(' ')}`
  const script = `printf '%s' "$$" > ${quoteArg(input.pidPath)} ; ${run}`
  return `setsid --wait sh -c ${quoteArg(script)}`
}

export function serializeProcessMeta(meta: ProcessMeta): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(meta))
}

/**
 * A meta file back into a record, or `undefined` for anything that is not one.
 *
 * Total rather than throwing, because every caller of it is already on a path where the answer
 * is "then say what little is known": the meta is informational, and a turn can delete or
 * rewrite the file it lives in.
 */
export function parseProcessMeta(bytes: Uint8Array, id: string): ProcessMeta | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes))
  }
  catch {
    return undefined
  }
  const meta = parsed as Partial<ProcessMeta> | null
  if (typeof meta?.id !== 'string' || meta.id !== id || !Array.isArray(meta.command) || meta.command.length === 0) {
    return undefined
  }
  if (!meta.command.every(part => typeof part === 'string') || typeof meta.startedAt !== 'string') {
    return undefined
  }
  return {
    id,
    command: meta.command as unknown as SandboxCommand,
    cwd: typeof meta.cwd === 'string' ? meta.cwd : undefined,
    startedAt: meta.startedAt,
  }
}
