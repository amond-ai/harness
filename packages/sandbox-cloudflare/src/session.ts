/**
 * The Cloudflare backend for {@link SandboxSession}: a mapping layer over `HarnessSandbox`.
 *
 * The contract's process id names the process's directory, so a cold session reaches the same
 * process with nothing but that id. `starting` is reported as `running` with pid `0`.
 */
import type {
  ProcessExit,
  ProcessFailure,
  ProcessStatus,
  SandboxCommand,
  SandboxExecOptions,
  SandboxProcessHandle,
  SandboxSession,
} from '@amond-ai/sandbox'
import type { JournalPaths, JournalReadOptions } from '@amond-ai/sandbox/journal'
import type { HarnessSandboxRpc, ProcessLogFile, ProcessMeta, ProcessReport } from './rpc'
import { SandboxNoExitRecordError, SandboxWaitTimeoutError } from '@amond-ai/sandbox'
import { abortable, createProcessLogs, isProcessId } from '@amond-ai/sandbox/journal'
import { createCloudflareFiles } from './files'

const DEFAULT_POLL_MS = 1_000
const DEFAULT_FOLLOW_MS = 1_000
const DEFAULT_LIVENESS_MS = 1_000
const READ_LIMIT = 1024 * 1024

const LOG_PATHS: JournalPaths = {
  stdout: 'stdout.log',
  stderr: 'stderr.log',
  exit: 'exit-code',
  meta: 'meta.json',
}

export const NO_EXIT_RECORD: ProcessFailure = {
  code: 'no_exit_record',
  message: 'process is not running and recorded no exit code',
}

export interface CloudflareSessionOptions {
  newProcessId?: () => string
  now?: () => string
  /** How often `waitForExit` re-reads the status. Defaults to {@link DEFAULT_POLL_MS}. */
  pollIntervalMs?: number
  /** How often a following `logs()` polls. Defaults to {@link DEFAULT_FOLLOW_MS}. */
  followIntervalMs?: number
  /** How often a following `logs()` asks whether the process is gone. */
  livenessIntervalMs?: number
  /** Monotonic milliseconds, injected so a wait's deadline can be exercised without waiting it out. */
  monotonicNowMs?: () => number
}

/** A command killed by signal `n` leaves `128 + n`, which is passed through undecoded. */
export function exitOf(code: number, timedOut: boolean): ProcessExit {
  return { code, timedOut }
}

/** Resolve after `ms`, or as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted === true) {
    return Promise.resolve()
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

export function createCloudflareSession(
  sandbox: HarnessSandboxRpc,
  options: CloudflareSessionOptions = {},
): SandboxSession {
  const newProcessId = options.newProcessId ?? (() => crypto.randomUUID())
  const now = options.now ?? (() => new Date().toISOString())
  const pollMs = options.pollIntervalMs ?? DEFAULT_POLL_MS
  const elapsedMs = options.monotonicNowMs ?? (() => performance.now())

  function withoutMeta(id: string): ProcessMeta {
    return { id, command: ['<unrecorded>'], startedAt: now() }
  }

  function statusOf(meta: ProcessMeta, report: ProcessReport | undefined): ProcessStatus {
    const base = { id: meta.id, pid: 0, command: meta.command, cwd: meta.cwd, startedAt: meta.startedAt }
    const state = report?.state
    if (state?.state === 'running') {
      return { ...base, pid: state.pid, state: 'running' }
    }
    if (state?.state === 'starting') {
      return { ...base, state: 'running' }
    }
    if (state?.state === 'exited') {
      return { ...base, state: 'exited', exit: exitOf(state.code, state.timedOut), endedAt: now() }
    }
    return { ...base, state: 'error', error: NO_EXIT_RECORD, endedAt: now() }
  }

  /**
   * The abort reaches both the status read and the delay between reads, so a caller that gives
   * up is not held by an RPC still pending against the container.
   */
  async function waitForExit(id: string, waitOptions?: { timeout?: number, signal?: AbortSignal }): Promise<ProcessExit> {
    const startedAt = elapsedMs()
    const timeout = waitOptions?.timeout
    const signal = waitOptions?.signal
    const deadline = timeout === undefined ? undefined : startedAt + timeout
    while (true) {
      let report: ProcessReport | undefined
      try {
        report = await abortable(sandbox.processStatus(id), signal)
      }
      catch (cause) {
        if (signal?.aborted === true) {
          throw new SandboxWaitTimeoutError(id, timeout ?? elapsedMs() - startedAt)
        }
        throw cause
      }
      const state = report?.state
      if (state?.state === 'exited') {
        return exitOf(state.code, state.timedOut)
      }
      if (state === undefined || state.state === 'lost') {
        throw new SandboxNoExitRecordError(id)
      }
      const at = elapsedMs()
      if (signal?.aborted === true || (deadline !== undefined && at >= deadline)) {
        throw new SandboxWaitTimeoutError(id, timeout ?? at - startedAt)
      }
      const remaining = deadline === undefined ? pollMs : Math.min(pollMs, deadline - at)
      // An abort during the delay ends it early; the next read then rejects at once.
      await sleep(Math.max(0, remaining), signal)
    }
  }

  async function kill(id: string, signal: number | undefined): Promise<void> {
    const outcome = await sandbox.killProcess(id, signal)
    if (outcome.delivered) {
      return
    }
    const ended = outcome.reason === 'exited' || outcome.reason === 'not-running'
    if (signal === undefined && ended) {
      return
    }
    const detail = outcome.detail === undefined ? '' : ` (${outcome.detail})`
    console.warn(
      `cloudflare could not deliver ${signal === undefined ? 'SIGTERM' : `signal ${signal}`} `
      + `to '${id}': ${outcome.reason}${detail}`,
    )
  }

  async function silenced<T>(read: Promise<T>, readOptions: JournalReadOptions | undefined, fallback: T): Promise<T> {
    try {
      return await abortable(read, readOptions?.signal)
    }
    catch (cause) {
      if (readOptions?.partial === 'fail' || readOptions?.signal?.aborted === true) {
        throw cause
      }
      return fallback
    }
  }

  function logsFor(id: string): SandboxProcessHandle['logs'] {
    const file = (path: string): ProcessLogFile => path as ProcessLogFile
    return createProcessLogs({
      paths: LOG_PATHS,
      readExitCode: async (readOptions) => {
        const state = (await silenced(sandbox.processStatus(id), readOptions, undefined))?.state
        return state?.state === 'exited' ? state.code : undefined
      },
      // Up to the end the file had when the read began, in bounded replies: a follow's final
      // drain reads once, so stopping at READ_LIMIT would drop output, while chasing a log that
      // grows faster than it is read would never return. Later bytes are the next poll's.
      readSliceFrom: async (path, offset, readOptions) => {
        const end = await silenced(sandbox.processLogSize(id, file(path)), readOptions, offset)
        const chunks: Uint8Array[] = []
        let at = offset
        while (at < end) {
          const chunk = await silenced(
            sandbox.readProcessLog(id, file(path), at, Math.min(READ_LIMIT, end - at)),
            readOptions,
            new Uint8Array(),
          )
          if (chunk.length === 0) {
            break
          }
          chunks.push(chunk)
          at += chunk.length
        }
        if (chunks.length <= 1) {
          return { data: chunks[0] ?? new Uint8Array(), total: at }
        }
        const data = new Uint8Array(at - offset)
        let filled = 0
        for (const chunk of chunks) {
          data.set(chunk, filled)
          filled += chunk.length
        }
        return { data, total: at }
      },
      readEndOffset: (path, readOptions) => abortable(sandbox.processLogSize(id, file(path)), readOptions?.signal),
      async* streamFile(path, partial) {
        let offset = 0
        for (;;) {
          let data: Uint8Array
          try {
            data = await sandbox.readProcessLog(id, file(path), offset, READ_LIMIT)
          }
          catch (cause) {
            if (partial === 'fail') {
              throw cause
            }
            return
          }
          if (data.length > 0) {
            yield data
          }
          if (data.length < READ_LIMIT) {
            return
          }
          offset += data.length
        }
      },
      isGone: async (signal) => {
        const state = (await abortable(sandbox.processStatus(id), signal))?.state
        return state === undefined || state.state === 'exited' || state.state === 'lost'
      },
      now,
      elapsedMs,
      followIntervalMs: options.followIntervalMs ?? DEFAULT_FOLLOW_MS,
      livenessIntervalMs: options.livenessIntervalMs ?? DEFAULT_LIVENESS_MS,
    })
  }

  function handleFor(meta: ProcessMeta): SandboxProcessHandle {
    return {
      id: meta.id,
      status: async () => statusOf(meta, await sandbox.processStatus(meta.id)),
      logs: logsFor(meta.id),
      waitForExit: waitOptions => waitForExit(meta.id, waitOptions),
      kill: signal => kill(meta.id, signal),
    }
  }

  return {
    ...createCloudflareFiles(sandbox),

    exec: async (command: SandboxCommand, execOptions?: SandboxExecOptions) => {
      const id = newProcessId()
      const report = await sandbox.startProcess(id, command, {
        cwd: execOptions?.cwd,
        env: execOptions?.env,
        timeout: execOptions?.timeout,
      })
      return handleFor(report.meta ?? { id, command: [...command], cwd: execOptions?.cwd, startedAt: now() })
    },

    getProcess: async (id: string) => {
      if (!isProcessId(id)) {
        return null
      }
      const report = await sandbox.processStatus(id)
      return report === undefined ? null : handleFor(report.meta ?? withoutMeta(id))
    },

    listProcesses: async () => {
      const reports = await sandbox.listProcesses()
      return reports.map(report => statusOf(report.meta ?? withoutMeta(report.id), report))
    },

    exists: async (path: string) => ({ exists: await sandbox.exists(path) }),

    destroy: async () => {
      await sandbox.destroySandbox()
    },
  }
}
