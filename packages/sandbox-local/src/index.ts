// @amond-ai/sandbox-local
//
// A local-process backend for `@amond-ai/sandbox`.
//
// The machine remembers a process perfectly well; it is the orchestrator that goes away. A
// desktop app is quit and relaunched mid-turn, and the contract still requires `getProcess`
// and `listProcesses` to answer about a sandbox this process never started — so this backend
// journals a command's transcript, its pid and its exit status to disk, and verifies liveness
// against the kernel rather than trusting a pid it wrote down. See `./journal.ts` for the
// layout and `./registry.ts` for why a recorded pid is not an answer on its own.
//
// The name says sandbox and the backend is not one: no filesystem boundary, no network policy,
// no resource limit. See the README before reaching for it as a security boundary.

export { journalledScript, journalPaths, parseJournalScript, parseProcessRecord, serializeProcessRecord } from './journal'
export type { JournalPaths, ProcessRecord, RecoveredScript } from './journal'

export { createJournalIo } from './journal-io'
export type { JournalIo } from './journal-io'

export { createLocalSession } from './local-session'
export type { LocalSessionOptions } from './local-session'

export type {
  LocalHost,
  LocalProcessRow,
  LocalSlice,
  LocalSpawned,
  LocalSpawnSpec,
} from './local-surface'

export { decodeCursor, encodeCursor, replayPositioned } from './log-replay'

export { nodeLocalHost } from './node-host'

export { isProcessId, isSandboxId, resolveWithin, sandboxPaths, STATE_DIRECTORY_NAME } from './paths'
export type { SandboxLayout, SandboxPaths } from './paths'

export { createLocalProvider } from './provider'
export type { LocalProviderOptions } from './provider'

export { createProcessRegistry } from './registry'
export type { Liveness, ProcessRegistry, ProcessRegistryOptions } from './registry'

export { quoteArg, quoteArgv, unquoteArgv } from './shell-quote'
