/**
 * The fake Vercel sandbox this package's suites are written against.
 *
 * It lives in its own module because the suites are split by responsibility — the probe, the kill
 * path, the file surface, the session, and the provider — and every one of them needs the same
 * sandbox. Keeping one copy is what makes the split safe: a fake that drifted per file would let
 * a suite pass against a sandbox the others no longer model. Not a `*.test.ts` file, so the
 * runner does not pick it up as a suite of its own.
 *
 * Its companion is `vercel-session.fixtures.ts`, which writes *journal state* into this fake — a
 * started wrapper, its output, its ending. The cut is between what the sandbox is and what a turn
 * did inside it, and it exists because one file holding both was seven lines under the
 * repository's 500-LOC limit with a provider suite still to write.
 *
 * **It does not simulate a shell**, and that is deliberate. `runCommand` dispatches on `(cmd,
 * args)` and models the four commands this backend actually issues — `mkdir`, `test`, `ls` and
 * the probe — answering each from `files`, `dirs` and `procs` directly. A fake that interpreted
 * shell would be a second implementation of the probe script with its own bugs, and the thing
 * most worth pinning about that script — its exact text — is pinned by a snapshot instead.
 */
import type { VercelCommandFinished, VercelCommandLike, VercelRunParams, VercelSandboxLike } from './vercel-surface'

export const ROOT = '/vercel/sandbox/.agent-runs'
export const AT = '2026-09-14T13:00:00.000Z'
export const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
export const decode = (data: Uint8Array): string => new TextDecoder().decode(data)

/** One process in the fake's table: what its command line reads as, and which group it is in. */
export interface FakeProcess {
  cmdline: string
  pgid: number
}

export interface Fake {
  sandbox: VercelSandboxLike
  files: Map<string, Uint8Array>
  dirs: Set<string>
  /** The sandbox's process table, keyed by pid. */
  procs: Map<number, FakeProcess>
  /** Every `runCommand`, in order, so a test can pin what was issued and how often. */
  ran: { cmd: string, args: string[] }[]
  /**
   * Every *detached* `runCommand`, whole.
   *
   * Kept separately from {@link ran}, and with its params intact, because the thing worth pinning
   * about an `exec` is not its argv alone: `cwd` and `env` ride Vercel's own parameters rather
   * than a shell prologue, and only the params say whether they did.
   */
  detached: VercelRunParams[]
  routes: { url: string, subdomain: string, port: number }[]
  updates: { ports?: number[], timeout?: number }[]
  extended: number[]
  /**
   * Ports `update` accepts and then does not route.
   *
   * Models the only failure `ensureRouted` cannot tell from success without re-reading: an
   * `update` that resolves while the route never appears, which `domain()` would otherwise meet
   * as a bare `No route for port <p>` from somewhere else entirely.
   */
  unroutable: Set<number>
  /**
   * Substrings that make a matching `runCommand` reject.
   *
   * A dead transport, not a non-zero exit — the two mean opposite things almost everywhere in
   * this backend, and a fake that could only express one would leave half the reasoning untested.
   */
  failing: Set<string>
  calls: { runCommand: number, getCommand: number, read: number, write: number }
  /** The running VM's id. `undefined` models a sandbox with no session, which throws in the SDK. */
  session: string | undefined
  /** When Vercel says it will stop this sandbox, or `undefined` when the API reported none. */
  expiresAt: Date | undefined
  /**
   * Pids that ignore signals.
   *
   * Models the case a confirm-reaped exists for: a kill the kernel accepted — `kill(1)` exits 0
   * because the group had members — that nonetheless left something running.
   */
  stubborn: Set<number>
  /** Commands `getCommand` resolves, keyed by cmdId. */
  commands: Map<string, VercelCommandLike>
  deleted: boolean
}

interface FakeState extends Omit<Fake, 'sandbox'> {}

/** A finished command, which is what every non-detached `runCommand` answers with. */
function finished(exitCode: number, stdout = '', stderr = ''): VercelCommandFinished {
  return {
    cmdId: 'cmd_fake',
    exitCode,
    startedAt: 0,
    cwd: '/vercel/sandbox',
    kill: async () => {},
    wait: async () => finished(exitCode, stdout, stderr),
    stdout: async () => stdout,
    stderr: async () => stderr,
  }
}

/** The journal base path a probe script is about — `<root>/<id>`, read out of its own text. */
function probeTarget(script: string): string | undefined {
  return /cat 2> \/dev\/null < '([^']*)\.pgid'/.exec(script)?.[1]
}

/** The wrapper marker the probe script matches a command line against. */
function probeMarker(script: string): string {
  return /^m='(.*?)' ; g=/.exec(script)?.[1]?.replaceAll(`'\\''`, `'`) ?? ''
}

/**
 * The five fields the probe prints, answered from the fake's own files and process table.
 *
 * This is the one place the fake reproduces behaviour rather than state, and it reproduces the
 * *decisions* — liveness before the exit record, the cmdline marker gating `live`, `-1` for an
 * absent file, the 32-byte cap — not the shell that implements them.
 */
function probeOutput(state: FakeState, base: string, marker: string): string {
  const group = Number(decode(state.files.get(`${base}.pgid`) ?? new Uint8Array()).trim())
  let liveness = 'nopid'
  if (Number.isSafeInteger(group) && group > 0) {
    const leader = state.procs.get(group)
    if (leader !== undefined) {
      // The pid is in use, so its command line settles the question — a stranger that recycled
      // it is `stranger` however many processes its own group holds, which is a different kill
      // target from the `none` below even though both read as gone.
      liveness = leader.cmdline.startsWith(marker) ? 'live' : 'stranger'
    }
    else {
      liveness = [...state.procs.values()].some(proc => proc.pgid === group) ? 'survivors' : 'none'
    }
  }
  const length = (suffix: string): string => {
    const found = state.files.get(`${base}${suffix}`)
    return found === undefined ? '-1' : String(found.length)
  }
  const exit = state.files.get(`${base}.exit`)
  return [
    liveness,
    length('.out'),
    length('.err'),
    state.files.has(`${base}.timeout`) ? 't' : '',
    exit === undefined ? '' : decode(exit.subarray(0, 32)),
  ].join('\n')
}

/** `kill <expression>` against the fake's table, answering the way `kill(1)` does. */
function applyKill(state: FakeState, expression: string): number {
  const group = /^-[A-Z0-9]+ -- -(\d+)$/.exec(expression)
  if (group) {
    const target = Number(group[1])
    const members = [...state.procs].filter(([, proc]) => proc.pgid === target)
    for (const [pid] of members) {
      if (!state.stubborn.has(pid)) {
        state.procs.delete(pid)
      }
    }
    return members.length > 0 ? 0 : 1
  }
  const single = /^-[A-Z0-9]+ (\d+)$/.exec(expression)
  if (single) {
    const pid = Number(single[1])
    if (!state.procs.has(pid)) {
      return 1
    }
    if (!state.stubborn.has(pid)) {
      state.procs.delete(pid)
    }
    return 0
  }
  return 1
}

/**
 * A handle for a command the fake was asked to start and deliberately did not run.
 *
 * `exitCode` is a plain data property so {@link endProcess} can settle it — that is the warm,
 * *corroborated* path, the one reading in this backend the turn cannot forge, and a fixture that
 * could not produce it would leave `statusOf`'s first step untestable.
 */
function detachedCommand(cmdId: string): VercelCommandLike & { killed: string[] } {
  const killed: string[] = []
  return {
    cmdId,
    exitCode: null,
    startedAt: 0,
    cwd: '/vercel/sandbox',
    killed,
    kill: async (signal) => {
      killed.push(String(signal))
    },
    wait: async () => finished(0),
  }
}

function runCommand(state: FakeState, params: VercelRunParams): VercelCommandLike {
  const args = params.args ?? []
  state.calls.runCommand++
  state.ran.push({ cmd: params.cmd, args })

  // `exec`'s wrapper. Started, remembered and *not* run: the fake does not simulate a shell, so a
  // test says what the process did with {@link startProcess} and the helpers around it.
  if (params.detached === true) {
    state.detached.push(params)
    const command = detachedCommand(`cmd_${String(state.detached.length)}`)
    state.commands.set(command.cmdId, command)
    return command
  }

  if (params.cmd === 'mkdir' && args[args.length - 1] !== undefined) {
    state.dirs.add(args[args.length - 1] as string)
    return finished(0)
  }
  if (params.cmd === 'test') {
    const path = args[1] ?? ''
    const found = args[0] === '-d' ? state.dirs.has(path) : state.dirs.has(path) || state.files.has(path)
    return finished(found ? 0 : 1)
  }
  if (params.cmd === 'ls') {
    const root = args[args.length - 1] ?? ''
    if (!state.dirs.has(root)) {
      return finished(2, '', `ls: cannot access '${root}': No such file or directory`)
    }
    const prefix = `${root}/`
    const names = [...state.files.keys()]
      .filter(path => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
      .map(path => path.slice(prefix.length))
    return finished(0, names.length === 0 ? '' : `${names.join('\n')}\n`)
  }
  if (params.cmd === 'sh' && args[0] === '-c') {
    const script = args[1] ?? ''
    const base = probeTarget(script)
    if (base !== undefined) {
      return finished(0, probeOutput(state, base, probeMarker(script)))
    }
    const killed = /^kill (.*)$/.exec(script)
    if (killed) {
      return finished(applyKill(state, killed[1] ?? ''))
    }
    // The two shell one-liners the file surface issues, both of which take their path as `$1`.
    const path = args[3] ?? ''
    if (script.startsWith('mkdir -p')) {
      state.dirs.add(path)
      return finished(0)
    }
    if (script.startsWith('test -e')) {
      return finished(state.files.has(path) || state.dirs.has(path) ? 0 : 1)
    }
  }
  return finished(127, '', `fake sandbox: unmodelled command '${params.cmd}'`)
}

export function fakeSandbox(): Fake {
  const state: FakeState = {
    files: new Map<string, Uint8Array>(),
    dirs: new Set<string>([ROOT]),
    procs: new Map<number, FakeProcess>(),
    ran: [],
    detached: [],
    routes: [],
    updates: [],
    extended: [],
    failing: new Set<string>(),
    unroutable: new Set<number>(),
    stubborn: new Set<number>(),
    calls: { runCommand: 0, getCommand: 0, read: 0, write: 0 },
    session: 'ses_1',
    expiresAt: undefined,
    commands: new Map<string, VercelCommandLike>(),
    deleted: false,
  }

  const run = ((params: VercelRunParams) => {
    const line = `${params.cmd} ${(params.args ?? []).join(' ')}`
    for (const pattern of state.failing) {
      if (line.includes(pattern)) {
        state.calls.runCommand++
        state.ran.push({ cmd: params.cmd, args: params.args ?? [] })
        return Promise.reject(new Error(`fake sandbox: transport failure for '${pattern}'`))
      }
    }
    return Promise.resolve(runCommand(state, params))
  }) as VercelSandboxLike['runCommand']

  const sandbox: VercelSandboxLike = {
    name: 'sbx-1',
    get routes() {
      return state.routes
    },
    domain: (port) => {
      const route = state.routes.find(candidate => candidate.port === port)
      if (!route) {
        throw new Error(`No route for port ${String(port)}`)
      }
      return route.url
    },
    sessionId: () => state.session,
    get expiresAt() {
      return state.expiresAt
    },
    runCommand: run,
    getCommand: async (cmdId) => {
      state.calls.getCommand++
      const found = state.commands.get(cmdId)
      if (!found) {
        // The shape the SDK's `APIError` carries, which `isNotFound` reads structurally.
        throw Object.assign(new Error(`no such command: ${cmdId}`), { response: { status: 404 } })
      }
      return found
    },
    readFileToBuffer: async ({ path }) => {
      state.calls.read++
      return state.files.get(path) ?? null
    },
    writeFiles: async (files) => {
      state.calls.write++
      for (const file of files) {
        state.files.set(file.path, typeof file.content === 'string' ? encode(file.content) : file.content)
      }
    },
    update: async (params) => {
      state.updates.push(params)
      if (params.ports === undefined) {
        return
      }
      // Vercel treats `ports` as the full desired list, so the fake does too: anything omitted
      // is deregistered. A backend that sent `[port]` alone would silently unroute every other
      // port, and a fake that merged instead would hide it.
      state.routes.splice(0, state.routes.length, ...params.ports
        .filter(port => !state.unroutable.has(port))
        .map(port => ({ url: `https://sbx-1-${String(port)}.vercel.run`, subdomain: `sbx-1-${String(port)}`, port })))
    },
    extendTimeout: async (ms) => {
      state.extended.push(ms)
      // Additive, which is the whole reason `lifetime.ts` tracks a deadline of its own.
      if (state.expiresAt !== undefined) {
        state.expiresAt = new Date(state.expiresAt.getTime() + ms)
      }
    },
    delete: async () => {
      state.deleted = true
    },
  }

  return {
    ...state,
    sandbox,
    // Getters for the two scalars, because a spread copies their *value*: a test that set
    // `fake.session` on a plain copy would leave the sandbox answering the old one, and the
    // whole point of the field is that the warm path stops matching when it changes.
    get session() {
      return state.session
    },
    set session(value: string | undefined) {
      state.session = value
    },
    get deleted() {
      return state.deleted
    },
    get expiresAt() {
      return state.expiresAt
    },
    set expiresAt(value: Date | undefined) {
      state.expiresAt = value
    },
  }
}

/** A command handle for the warm path — the SDK's own record of how a process ended. */
export function fakeCommand(cmdId: string, exitCode: number | null): VercelCommandLike & { killed: string[] } {
  const killed: string[] = []
  return {
    cmdId,
    exitCode,
    startedAt: 0,
    cwd: '/vercel/sandbox',
    killed,
    kill: async (signal) => {
      killed.push(String(signal))
    },
    wait: async () => finished(exitCode ?? 0),
  }
}
