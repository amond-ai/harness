// @amond-ai/sandbox/journal
//
// The runtime-neutral half of the process journal: its on-disk layout, the cursor codec, and
// the reads (`logs()` over a journal) and tail behind it. A backend supplies the file reads
// and the liveness verdict; what it reads them *with* — an SDK, `exec` — is its own.

export { followJournal } from './follow'
export type { FollowOptions, JournalTail } from './follow'
export {
  isProcessId,
  journalPaths,
  parseJournalMeta,
  serializeJournalMeta,
  STDOUT_SUFFIX,
} from './paths'
export type { JournalMeta, JournalPaths } from './paths'
export { createProcessLogs } from './reads'
export type { LogReadSources, PartialRead } from './reads'
export { decodeCursor, encodeCursor, replayPositioned } from './replay'
export type { JournalSlice } from './replay'
