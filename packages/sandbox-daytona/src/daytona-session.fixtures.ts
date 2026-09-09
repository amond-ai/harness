/**
 * The fake Daytona sandbox the `daytona-session.*.test.ts` suites are written against.
 *
 * It lives in its own module because those suites are split by responsibility — process
 * lifecycle, waiting and status, log reads, killing — and every one of them needs the same fake.
 * Keeping one copy is what makes the split safe: a fake that drifted per file would let a suite
 * pass against a sandbox the others no longer model. Not a `*.test.ts` file, so the runner does
 * not pick it up as a suite of its own.
 */
import type { SandboxSession } from '@amond-ai/sandbox'
import type { DaytonaSessionOptions } from './daytona-session'
import type { DaytonaSandboxLike } from './daytona-surface'
import { createDaytonaSession } from './daytona-session'

export const ROOT = '/home/daytona/.agent-runs'
export const AT = '2026-09-09T13:00:00.000Z'
export const encode = (text: string): Uint8Array => new TextEncoder().encode(text)
export const decode = (data: Uint8Array): string => new TextDecoder().decode(data)

/**
 * Daytona's own shape for "there is no such thing": a `DaytonaError` carrying HTTP 404.
 *
 * The class is not imported — that would put the real SDK in the tests — but `statusCode` is the
 * field the SDK's `errorClassFromStatusCode` derives `DaytonaNotFoundError` from, so this is the
 * same fact the backend reads.
 */
export function notFound(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 404, code: 'NOT_FOUND' })
}

/** Anything that is not an absence — the shape every read must refuse to call "gone". */
export function transportFailure(message = 'connection reset'): Error {
  return Object.assign(new Error(message), { statusCode: 502 })
}

interface FakeCommand { id: string, command: string, exitCode?: number }

export interface Fake {
  sandbox: DaytonaSandboxLike
  files: Map<string, Uint8Array>
  dirs: Set<string>
  sessions: Map<string, FakeCommand[]>
  /** Retained output per `${sessionId}/${commandId}`, which survives the command's exit. */
  logs: Map<string, { stdout: string, stderr: string }>
  /** One-shot commands run outside a session — the kill path's only tool. */
  ran: string[]
  /** What a one-shot command exits with, by the prefix of its command line. */
  exitCodes: Map<string, number>
  deleted: boolean
  /** Daytona's own lifecycle state, which a reattach reads to decide whether to wake the sandbox. */
  state: string
  /** The wake calls a reattach made, in order — so "started once" is distinguishable from "twice". */
  woke: string[]
  /**
   * The states successive `refreshData` calls land the sandbox in, consumed front to back — how a
   * test scripts a sandbox that is `archiving` on one read and `archived` on the next. An empty
   * queue leaves `state` where it is, which is what a sandbox that never settles looks like.
   */
  refreshes: string[]
  /**
   * Whether `refreshData` answers at all — a `true` leaves the call pending forever, which is how a
   * test scripts the stalled Daytona request a settle deadline has to bound on its own.
   */
  stalls: boolean
  /** Call counts, so a test can pin *how often* a loop reaches the network. */
  calls: { getSession: number, getSessionCommand: number, logs: number }
  /**
   * Calls that must fail rather than answer, keyed by path or session id — plus `exec:<sessionId>`
   * for the one call that is not a read: starting the session's command.
   */
  failing: Set<string>
}

function key(sessionId: string, commandId: string): string {
  return `${sessionId}/${commandId}`
}

function fakeProcess(fake: Fake, state: { nextCommand: number }): DaytonaSandboxLike['process'] {
  const commandsOf = (sessionId: string): FakeCommand[] => {
    const found = fake.sessions.get(sessionId)
    if (!found) {
      throw notFound(`session ${sessionId} not found`)
    }
    return found
  }
  return {
    createSession: async (sessionId) => {
      fake.sessions.set(sessionId, [])
    },
    getSession: async (sessionId) => {
      fake.calls.getSession++
      if (fake.failing.has(sessionId)) {
        throw transportFailure()
      }
      return { sessionId, commands: commandsOf(sessionId) }
    },
    listSessions: async () =>
      [...fake.sessions].map(([sessionId, commands]) => ({ sessionId, commands })),
    deleteSession: async (sessionId) => {
      fake.sessions.delete(sessionId)
    },
    getSessionCommand: async (sessionId, commandId) => {
      fake.calls.getSessionCommand++
      if (fake.failing.has(sessionId)) {
        throw transportFailure()
      }
      const found = commandsOf(sessionId).find(command => command.id === commandId)
      if (!found) {
        throw notFound(`command ${commandId} not found`)
      }
      return found
    },
    executeSessionCommand: async (sessionId, request) => {
      const commands = commandsOf(sessionId)
      if (fake.failing.has(`exec:${sessionId}`)) {
        throw transportFailure('command refused')
      }
      const id = `cmd-${state.nextCommand++}`
      commands.push({ id, command: request.command })
      fake.logs.set(key(sessionId, id), { stdout: '', stderr: '' })
      return { cmdId: id }
    },
    getSessionCommandLogs: async (sessionId, commandId) => {
      fake.calls.logs++
      commandsOf(sessionId)
      const found = fake.logs.get(key(sessionId, commandId))
      if (!found) {
        throw notFound(`logs for ${commandId} not found`)
      }
      return { ...found, output: found.stdout + found.stderr }
    },
    executeCommand: async (command) => {
      fake.ran.push(command)
      const matched = [...fake.exitCodes].find(([prefix]) => command.startsWith(prefix))
      return { exitCode: matched?.[1] ?? 0, result: '' }
    },
  }
}

function fakeFs(fake: Fake): DaytonaSandboxLike['fs'] {
  return {
    createFolder: async (path) => {
      fake.dirs.add(path.replace(/\/+$/, ''))
    },
    downloadFile: async (path) => {
      if (fake.failing.has(path)) {
        throw transportFailure()
      }
      const found = fake.files.get(path)
      if (!found) {
        throw notFound(`file ${path} not found`)
      }
      return found
    },
    uploadFileStream: async (source, remotePath) => {
      if (fake.failing.has(remotePath)) {
        throw transportFailure('upload refused')
      }
      fake.files.set(remotePath, source)
    },
    getFileDetails: async (path) => {
      const trimmed = path.replace(/\/+$/, '')
      if (fake.failing.has(path)) {
        throw transportFailure()
      }
      if (!fake.files.has(path) && !fake.dirs.has(trimmed)) {
        throw notFound(`path ${path} not found`)
      }
      return { name: trimmed.slice(trimmed.lastIndexOf('/') + 1) }
    },
  }
}

export function fakeSandbox(): Fake {
  const state = { nextCommand: 1 }
  const fake = {
    files: new Map<string, Uint8Array>(),
    dirs: new Set<string>(),
    sessions: new Map<string, FakeCommand[]>(),
    logs: new Map<string, { stdout: string, stderr: string }>(),
    ran: [] as string[],
    exitCodes: new Map<string, number>(),
    deleted: false,
    state: 'started',
    woke: [] as string[],
    refreshes: [] as string[],
    stalls: false,
    calls: { getSession: 0, getSessionCommand: 0, logs: 0 },
    failing: new Set<string>(),
  } as unknown as Fake
  fake.sandbox = {
    id: 'sbx-1',
    get state() {
      return fake.state
    },
    start: async () => {
      fake.woke.push('start')
      // Daytona reports `started` once the ask lands; the readiness is what `waitUntilStarted` is.
      fake.state = 'starting'
    },
    waitUntilStarted: async () => {
      fake.woke.push('waitUntilStarted')
      fake.state = 'started'
    },
    waitUntilStopped: async () => {
      fake.woke.push('waitUntilStopped')
      fake.state = 'stopped'
    },
    refreshData: async () => {
      fake.woke.push('refreshData')
      if (fake.stalls) {
        await new Promise(() => {})
      }
      const next = fake.refreshes.shift()
      if (next !== undefined) {
        fake.state = next
      }
    },
    process: fakeProcess(fake, state),
    fs: fakeFs(fake),
    getPreviewLink: async port => ({ url: `https://${String(port)}-sbx-1.proxy.daytona.works`, token: 'preview-token' }),
    delete: async () => {
      fake.deleted = true
    },
  }
  return fake
}

export function session(
  fake: Fake,
  ids: string[] = ['run-1'],
  extra: Partial<DaytonaSessionOptions> = {},
): SandboxSession {
  const queue = [...ids]
  return createDaytonaSession(fake.sandbox, {
    stateRoot: ROOT,
    newProcessId: () => queue.shift() ?? 'exhausted',
    now: () => AT,
    pollIntervalMs: 0,
    followIntervalMs: 0,
    ...extra,
  })
}

/** The command a process id runs, as the daemon holds it. */
export function commandOf(fake: Fake, processId: string): FakeCommand | undefined {
  return fake.sessions.get(processId)?.[0]
}

/** End a process the way the toolbox daemon does: it writes the exit code, nothing else. */
export function endProcess(fake: Fake, processId: string, code: number): void {
  const command = commandOf(fake, processId)
  if (command) {
    command.exitCode = code
  }
}

/** What the command has written so far. Retained past its exit, as Daytona retains it. */
export function setLogs(fake: Fake, processId: string, logs: { stdout?: string, stderr?: string }): void {
  const command = commandOf(fake, processId)
  if (!command) {
    return
  }
  const at = `${processId}/${command.id}`
  fake.logs.set(at, { stdout: logs.stdout ?? '', stderr: logs.stderr ?? '' })
}

/** The sandbox was stopped and restarted, and Daytona kept no session — the unproven case. */
export function forgetSession(fake: Fake, processId: string): void {
  fake.sessions.delete(processId)
}

/** A clock that leaps forward on every read, so hours of waiting cost no wall-clock time. */
export function leapingClock(stepMs: number): () => number {
  let at = 0
  return () => (at += stepMs)
}

/** Drain a stream, cancelling it on the way out so a reader that stops early is observable. */
export async function* streamOf<T>(stream: ReadableStream<T>): AsyncIterable<T> {
  const reader = stream.getReader()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        return
      }
      yield value
    }
  }
  finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
