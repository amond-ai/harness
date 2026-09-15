// @amond-ai/sandbox-vercel
//
// A `@vercel/sandbox` backend for `@amond-ai/sandbox`.
//
// Vercel exposes no process list, no argv and no pid, and a resumed sandbox is a *new* session in
// which a command id minted before the resume resolves nothing. The run workflow, meanwhile, reads
// a turn's transcript after it ends. So this backend journals the transcript, the pids and the
// exit status to the sandbox filesystem and answers `logs()`, `status()` and `waitForExit()` from
// there, corroborating with Vercel's own record whenever the session still holds one. See
// `./journal.ts` for the layout and `./vercel-probe.ts` for how liveness is decided.

export { isProcessId, journalledScript, journalPaths, parseJournalMeta, serializeJournalMeta } from './journal'
export type { JournalMeta, JournalPaths } from './journal'

export { decodeCursor, encodeCursor, replayPositioned } from './log-replay'
export type { JournalSlice } from './log-replay'

export { createVercelProvider, sandboxNameFor } from './provider'
export type { VercelProviderOptions } from './provider'

export { quoteArg, quoteArgv } from './shell-quote'
export { vercelSandboxApi, VercelSandboxAuthError } from './vercel-api'

export type { VercelApiOptions, VercelCreateParams, VercelSandboxApi } from './vercel-api'
export { createVercelSession } from './vercel-session'

export type { VercelSessionOptions } from './vercel-session'
export { isNotFound, isUnauthorized } from './vercel-surface'

export type {
  VercelCommandFinished,
  VercelCommandLike,
  VercelRoute,
  VercelRunParams,
  VercelSandboxLike,
} from './vercel-surface'
