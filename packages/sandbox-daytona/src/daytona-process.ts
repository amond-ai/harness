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
// Quoting only, and deliberately no `unquoteArgv`. The contract passes commands as argv, but
// Daytona's session API accepts a *string* — `executeSessionCommand(sessionId, { command })` — so
// the "no shell escaping needed" guarantee stops holding at this boundary and `quoteArgv` is what
// restores it. Nothing here ever reads a shell word list back into argv: Daytona records the
// command a session ran on the session itself and its exit code in the toolbox daemon, unlike
// e2b, which recovers a live turn's argv from the wrapper's command line in its process table
// (exited commands drop out of that table, and the journal carries what is left after exit).
import { quoteArg, quoteArgv } from '@amond-ai/sandbox/journal'

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
  /** Where the wrapper records `$$` and its identity, so a cold provider can still aim a kill. */
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

/**
 * Who a recorded pid was when the wrapper wrote it: the kernel boot and the process's start time.
 *
 * A pid alone is only a number, and after a sandbox restart that number can belong to anything.
 * The boot id catches a VM reboot; the start time (clock ticks since boot, `/proc/<pid>/stat`
 * field 22) catches a container restart, where the boot id is the host's and does not change but
 * a reused pid starts at a different tick. `exec` keeps the process, so the start time the
 * wrapper reads is the command's.
 */
export interface PidIdentity {
  bootId: string
  startTime: string
}

/**
 * A pid file back into its parts; `identity` is absent for a bare pid or a host without `/proc`.
 *
 * Only those two shapes are accepted. A record with an identity that does not parse — truncated,
 * or written by the turn itself — answers `NaN`, so the kill treats it as no record at all: taken
 * as a bare pid it would skip {@link identityCheck} and signal whatever holds that number now
 * (cubic review, PR #31). A host whose `/proc` is only partly readable writes one of the two
 * fields and lands here too; it cannot be told from a truncated record, so it takes the same
 * safe direction — a session delete for the default kill, no named signal at all.
 */
export function parsePidRecord(text: string): { pid: number, identity?: PidIdentity } {
  const fields = text.trim().split(/\s+/)
  const [pid, bootId = '', startTime = ''] = fields
  if (fields.length === 1) {
    return { pid: Number(pid) }
  }
  if (fields.length === 3 && /^\w[\w-]*$/.test(bootId) && /^\d+$/.test(startTime)) {
    return { pid: Number(pid), identity: { bootId, startTime } }
  }
  return { pid: Number.NaN }
}

/** `/proc/<pid>/stat` past the parenthesised name, whose own spaces would shift the fields. */
const START_TIME_OF = (pid: string): string => `sed "s/^.*) //" /proc/${pid}/stat 2>/dev/null | cut -d" " -f20`

/**
 * A shell test that exits 0 only if `pid` may still be the process the wrapper recorded.
 *
 * A missing `/proc/<pid>` passes: the leader is gone, and either its group still has members to
 * sweep or the signal finds nothing — a pid that has a live group cannot be handed to a stranger.
 * A live `/proc/<pid>` with another start time is a stranger, and fails.
 */
export function identityCheck(pid: number, identity: PidIdentity): string {
  const at = String(pid)
  return `[ "$(cat /proc/sys/kernel/random/boot_id)" = ${quoteArg(identity.bootId)} ] `
    + `&& { [ ! -e /proc/${at}/stat ] || [ "$(${START_TIME_OF(at)})" = ${quoteArg(identity.startTime)} ]; }`
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
 * 1. **`printf … "$$" …`** records the pid. There is no pid in the API and no signal API
 *    either, so a kill is an ordinary `kill(1)` and this file is the only thing that says what
 *    to aim it at. Written first, so it exists before the command can be worth killing. The boot
 *    id and start time ride along ({@link PidIdentity}) so a kill can tell the process from a
 *    stranger that inherited the number after a restart.
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
    launch.push('env', ...env.map(([name, value]) => quoteArg(`${name}=${value}`, `env ${name}`)))
  }
  launch.push(quoteArgv(input.command))
  const run = input.cwd === undefined ? launch.join(' ') : `cd ${quoteArg(input.cwd, 'the working directory')} && ${launch.join(' ')}`
  const record = `printf "%s %s %s" "$$" "$(cat /proc/sys/kernel/random/boot_id 2>/dev/null)" "$(${START_TIME_OF('$$')})"`
  const script = `${record} > ${quoteArg(input.pidPath, 'the pid journal path')} ; ${run}`
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
