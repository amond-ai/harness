// @amond-ai/sandbox-daytona
//
// A Daytona backend for `@amond-ai/sandbox`.
//
// One Daytona session per process, because Daytona's toolbox daemon already retains what the
// contract asks a backend for past a process's exit: `getSessionCommand(...).exitCode` — written
// by the daemon, not by the turn — and `getSessionCommandLogs`, which keeps stdout and stderr
// apart. That is why this backend carries no journal and no process-table cross-check, unlike
// `@amond-ai/sandbox-e2b`. See research note 035 for the verified SDK surface, 027 for the e2b
// measurements this contrasts with, and the README for the wrapper the two things Daytona does
// not expose — a pid and an argv — are recovered from.

export { daytonaSandboxApi } from './daytona-api'
export type { DaytonaApiOptions } from './daytona-api'

export { createDaytonaFiles } from './daytona-files'

export { createKillPath } from './daytona-kill'

export { isProcessId, parseProcessMeta, processPaths, serializeProcessMeta, wrappedCommand } from './daytona-process'
export type { ProcessMeta, ProcessPaths } from './daytona-process'

export { createDaytonaSession } from './daytona-session'
export type { DaytonaSandboxLike, DaytonaSessionOptions } from './daytona-session'

export { createCommandReader, NO_EXIT_RECORD } from './daytona-status'
export type { CommandReader, CommandVerdict } from './daytona-status'

export { isNotFound } from './daytona-surface'
export type { DaytonaSession, DaytonaSessionCommand, DaytonaSessionLogs } from './daytona-surface'

export type { ProcessEnding } from './log-reads'

export { decodeCursor, encodeCursor, replayPositioned, sliceFrom } from './log-replay'
export type { LogSlice } from './log-replay'

export { createDaytonaProvider, SANDBOX_ID_LABEL } from './provider'
export type { DaytonaProviderOptions, DaytonaSandboxApi } from './provider'

export { quoteArg, quoteArgv } from './shell-quote'
