/**
 * The `sdk` driver's idempotency guard: adopt the live turn host a partially observed earlier
 * start left running, or exec a new one.
 *
 * The same rule the `cli` driver's `liveTurnProcess` states, and the same reason — `exec` is not
 * idempotent, and `start-turn-N` is `NO_RETRIES` precisely because a replay that spawned a
 * second turn in one container would leave two agents editing one checkout.
 *
 * Separate from the cli guard rather than shared, because the two match on different things. The
 * cli argv carries the prompt, so an exact argv comparison is a comparison of the whole turn;
 * the host's argv carries only the workdir and the state dir, and the state dir is derived from
 * the run and the attempt — so it is the argv match *and* nothing else that identifies this
 * turn's host. That is sufficient and it is worth saying why: two attempts of one run have
 * different state dirs, and two runs have different run ids in theirs.
 */
import type { ProcessStatus, SandboxProcessHandle, SandboxSession } from '@amond-ai/sandbox'
import type { TurnStartSpec } from '../turn-driver'
import { isLive } from '../cli-turn-kill'

export interface AdoptOrExecInput {
  session: SandboxSession
  argv: readonly [executable: string, ...args: string[]]
  cwd: string | undefined
  /**
   * The host's environment, assembled on the exec path only.
   *
   * A thunk for the reason {@link TurnStartSpec.env} gives: assembling it can throw, and a throw
   * ahead of the guard below would end a restarted workflow before it adopts the host that is
   * still running the turn.
   */
  env: () => Record<string, string>
  recordedProcessId: string | undefined
  started: readonly string[]
  beforeExec?: () => Promise<void>
  /** `--bridge-state-dir`, which is also where this turn's channel token is kept. */
  stateDir: string
  /** The token a *new* host is started with; an adopted one answers with its own. */
  token: string
}

export type AdoptOrExecResult
  = | { adopted: true, processId: string, token: string }
    | { adopted: false, processId: string, process: SandboxProcessHandle }

/** Where the token a running host was started with is recorded, for an adopting re-entry. */
export function channelTokenPath(stateDir: string): string {
  return `${stateDir}/channel-token`
}

export async function adoptOrExec(input: AdoptOrExecInput): Promise<AdoptOrExecResult> {
  const live = await liveTurnHost(input)
  if (live !== undefined) {
    return { adopted: true, processId: live, token: await adoptedToken(input) }
  }
  await input.beforeExec?.()
  // Assembled here: past the guard, and before the token file is written, so a configuration
  // this turn cannot start under leaves no token recorded for a host that never existed.
  const env = input.env()
  // Written before the exec, so a host that is running is a host whose token is already
  // recoverable. It is not a new exposure: the same value is in that container's environment,
  // and the file never leaves it.
  await input.session.mkdir(input.stateDir, { recursive: true })
  await input.session.writeFile(channelTokenPath(input.stateDir), input.token)
  const process = await input.session.exec(input.argv, { cwd: input.cwd, env })
  return { adopted: false, processId: process.id, process }
}

/**
 * The token the adopted host is actually gating its port with.
 *
 * A workflow *restart* re-enters `start-turn-N` — `NO_RETRIES` forbids retry-on-failure, not
 * re-entry — and mints a fresh token on the way in. That token is not the one the running host
 * was given, so presenting it would be closed with 1008 by a bridge that is working correctly,
 * and the turn would be lost to a refusal that names nothing. The file the start wrote is what
 * makes the re-entry able to speak to the host it found.
 *
 * Raised rather than papered over: `start-turn` is the step that must not silently produce an
 * unusable handle, and a live host whose token cannot be read is exactly that.
 */
async function adoptedToken(input: AdoptOrExecInput): Promise<string> {
  const path = channelTokenPath(input.stateDir)
  if (!(await input.session.exists(path)).exists) {
    throw new Error(`adopted a live turn host with no recorded channel token at ${path}`)
  }
  return (await input.session.readFile(path)).content.trim()
}

async function liveTurnHost(input: AdoptOrExecInput): Promise<string | undefined> {
  if (input.recordedProcessId) {
    const handle = await input.session.getProcess(input.recordedProcessId)
    if (handle && isLive(await handle.status())) {
      return handle.id
    }
  }
  const processes = await input.session.listProcesses()
  return processes.find((process: ProcessStatus) =>
    isLive(process) && sameCommand(process.command, input.argv) && !input.started.includes(process.id))?.id
}

/** Compare argv exactly: executable, argument order, and every literal argument. */
function sameCommand(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
