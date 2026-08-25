// @pleaseai/sandbox-e2b
//
// An e2b backend for `@pleaseai/sandbox-contract`.
//
// e2b forgets a process the moment it exits — no `list()` entry, no `connect(pid)` — while
// the run workflow reads a turn's transcript after it ends. So this backend journals the
// transcript and exit status to the sandbox filesystem and answers `logs()`, `status()` and
// `waitForExit()` from there. See research note 027 for the measurements behind that, and
// `./journal.ts` for the layout.

export { e2bSandboxApi } from './e2b-api'
export type { E2bApiOptions } from './e2b-api'

export { createE2bSession } from './e2b-session'
export type { E2bSandboxLike, E2bSessionOptions } from './e2b-session'

export { isProcessId, journalledCommand, journalPaths, parseJournalMeta, serializeJournalMeta } from './journal'
export type { JournalMeta, JournalPaths } from './journal'

export { decodeCursor, encodeCursor, replayPositioned } from './log-replay'
export type { JournalSlice } from './log-replay'

export { createE2bProvider, SANDBOX_ID_METADATA_KEY } from './provider'
export type { E2bProviderOptions, E2bSandboxApi } from './provider'

export { quoteArg, quoteArgv } from './shell-quote'
