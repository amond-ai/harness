/**
 * What crosses the binding between the session and `HarnessSandbox`.
 *
 * Every value here is structured-clonable, because it travels over Workers RPC: plain objects,
 * `Uint8Array`, and `ReadableStream`.
 */
import type { SandboxCommand } from '@amond-ai/sandbox'

/** The two log files a process directory holds, under Cloudflare's own names. */
export type ProcessLogFile = 'stdout.log' | 'stderr.log'

/** What the object records about a process beside its log files, in `meta.json`. */
export interface ProcessMeta {
  id: string
  command: SandboxCommand
  cwd?: string
  startedAt: string
}

/**
 * One reading of Cloudflare's STATUS script, plus whether the process's own timeout fired.
 *
 * `starting` is the window between the process directory being created and the command writing
 * its pid; `lost` is a process that ended without recording an exit code, or one recorded by an
 * earlier instance of the container.
 */
export type ProcessState
  = | { state: 'starting' }
    | { state: 'running', pid: number }
    | { state: 'exited', code: number, timedOut: boolean }
    | { state: 'lost' }

export interface ProcessReport {
  id: string
  /** Absent when `meta.json` is gone or unreadable — the turn can write to its own directory. */
  meta?: ProcessMeta
  state: ProcessState
}

export interface StartProcessOptions {
  cwd?: string
  env?: Record<string, string>
  /** Milliseconds; the process group is sent SIGTERM, then SIGKILL, once it elapses. */
  timeout?: number
}

/**
 * Whether a signal reached the process group, and why not when it did not.
 *
 * `exited` and `not-running` mean there is nothing left to signal; the other reasons mean the
 * process may still be running and the signal did not reach it.
 */
export type KillOutcome
  = | { delivered: true }
    | { delivered: false, reason: 'exited' | 'not-running' | 'no-pid' | 'unknown-signal' | 'failed', detail?: string }

/**
 * The methods `HarnessSandbox` serves over its binding.
 *
 * The discovery reads — {@link processStatus}, {@link listProcesses}, the log reads — answer
 * from a stopped container without starting one, as the contract requires of `getProcess` and
 * `listProcesses`. {@link exists}, {@link startProcess} and the file methods start it.
 */
export interface HarnessSandboxRpc {
  /** Resolves once the command has recorded its pid, or a bounded wait for that has passed. */
  startProcess: (id: string, command: SandboxCommand, options?: StartProcessOptions) => Promise<ProcessReport>
  processStatus: (id: string) => Promise<ProcessReport | undefined>
  listProcesses: () => Promise<ProcessReport[]>
  /** Up to `limit` bytes of a log from byte `offset`; empty for a missing file or a stopped container. */
  readProcessLog: (id: string, file: ProcessLogFile, offset: number, limit: number) => Promise<Uint8Array>
  /** A log's length in bytes; `0` for a missing file or a stopped container. */
  processLogSize: (id: string, file: ProcessLogFile) => Promise<number>
  /** `signal` omitted sends SIGTERM, Cloudflare's own default. */
  killProcess: (id: string, signal?: number) => Promise<KillOutcome>
  readFile: (path: string) => Promise<Uint8Array>
  readFileStream: (path: string) => Promise<ReadableStream<Uint8Array>>
  writeFile: (path: string, content: string | Uint8Array | ReadableStream<Uint8Array>) => Promise<void>
  mkdir: (path: string, recursive: boolean) => Promise<void>
  exists: (path: string) => Promise<boolean>
  /** Stops the container if one runs and forgets every process; never starts one. */
  destroySandbox: () => Promise<void>
}
