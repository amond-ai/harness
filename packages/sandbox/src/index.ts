// @pleaseai/sandbox-contract
//
// The sandbox surface `apps/cf-orchestrator` runs against, owned here rather than imported
// from any one vendor's SDK. See `./types.ts` for why the Cloudflare shapes are copied
// structurally instead of re-exported, and why this is a peer of the AI SDK's sandbox
// session rather than an extension of it.

export { SandboxNoExitRecordError, SandboxWaitTimeoutError } from './types'

export type {
  ProcessExit,
  ProcessFailure,
  ProcessLogCursor,
  ProcessLogEvent,
  ProcessLogsOptions,
  ProcessStatus,
  SandboxCommand,
  SandboxExecOptions,
  SandboxProcessHandle,
  SandboxProvider,
  SandboxSession,
  WaitForExitOptions,
} from './types'
