/**
 * Reading the journal back — the file half of the backend, kept apart from the process half.
 *
 * Everything here answers from bytes on disk and nothing here asks the process table a
 * question, which is the same split the e2b backend draws between its journal reader and its
 * wrapper table, and for the same reason: what a process wrote down is a claim, what the
 * kernel says is running is a fact, and code that mixes the two loses track of which it is
 * holding.
 *
 * The local advantage over e2b's version of this file is the byte-range read. e2b has none,
 * so a positioned read there still transfers the whole file and drops the prefix as it
 * arrives; here an offset is an offset, and a watchdog sampling a turn's output every few
 * seconds costs the bytes that actually arrived rather than the transcript so far.
 */
import type { ProcessExit } from '@amond-ai/sandbox'
import type { JournalPaths } from './journal'
import type { LocalHost, LocalSlice } from './local-surface'

/** Bytes per chunk when the whole transcript is streamed rather than sliced. */
const CHUNK_BYTES = 64 * 1024

/**
 * The most an exit record may be, in bytes.
 *
 * A shell reports at most three digits — 255 is the largest status, and a signalled command
 * comes back as 128+n within the same range — so this is headroom rather than a fit. The cap
 * is here because the file is polled for the whole length of a turn and lives on a filesystem
 * the command itself can write to: unbounded, a journal replaced by something large is read
 * into memory in full, several times a second, for as long as the caller waits.
 */
const EXIT_RECORD_BYTES = 16

export interface JournalIo {
  /** The exit the wrapper recorded, or `undefined` while it has recorded none. */
  readExit: (paths: JournalPaths) => Promise<ProcessExit | undefined>
  /** The wrapped command's own pid, or `undefined` before the wrapper has written it. */
  readCommandPid: (paths: JournalPaths) => Promise<number | undefined>
  /** Bytes at or after `offset`, plus the file's length — `{ data: empty, total: 0 }` when absent. */
  readSliceFrom: (path: string, offset: number) => Promise<LocalSlice>
  /** Where a file ends, for a follower that starts at the live tail rather than the beginning. */
  readEndOffset: (path: string) => Promise<number>
  /** The file from `offset` to its end, in chunks, so a long transcript never lands in memory whole. */
  streamFile: (path: string, offset?: number) => AsyncGenerator<Uint8Array>
}

export function createJournalIo(host: LocalHost): JournalIo {
  return {
    readExit: async (paths: JournalPaths) => {
      const { data, total } = await host.readSlice(paths.exit, 0, EXIT_RECORD_BYTES)
      if (data.length === 0) {
        // No file. An absent one reads as empty rather than throwing, and absence is the
        // ordinary state for most of a turn: not over yet.
        return undefined
      }
      if (total > EXIT_RECORD_BYTES) {
        // Longer than any status the wrapper could have published, so it is not the wrapper's
        // file — and reading the rest of it to confirm that is the allocation the cap exists
        // to refuse.
        return undefined
      }
      const code = Number(new TextDecoder().decode(data).trim())
      if (!Number.isInteger(code)) {
        // Something else's file, or one the command replaced. Reporting `undefined` costs a
        // re-read; reporting a `NaN` exit would settle a turn as finished with a code nobody
        // can act on. What it is *not* is a half-written record: the wrapper publishes this
        // one by renaming a finished file into place, so the file either is not there or
        // holds the whole status.
        return undefined
      }
      // A shell reports a signalled command as 128+n and this passes that through rather than
      // decoding it: `exit 137` is a legal exit code, so the two are genuinely
      // indistinguishable here, and `ProcessExit.signal` is for a backend that was told.
      return { code, timedOut: await host.exists(paths.timeout) }
    },
    readCommandPid: async (paths: JournalPaths) => {
      const { data, total } = await host.readSlice(paths.pid, 0, EXIT_RECORD_BYTES)
      if (total > EXIT_RECORD_BYTES) {
        // Bounded for the same reason the exit status is: `kill` reads this every time, so a
        // journal file that grew — corrupted, or written by whatever else can reach the state
        // directory — would otherwise be allocated whole on each call. A pid does not run to
        // sixteen digits, so a file that long is not one.
        return undefined
      }
      const pid = Number(new TextDecoder().decode(data).trim())
      // A partial write would read as a different, still-plausible number and aim a signal at
      // a stranger, which is why the wrapper writes this with one `printf` of a value it
      // already holds: POSIX makes that single `write()` atomic against any concurrent read of
      // a regular file, so the observable states are absent, empty, and whole. It is not
      // renamed into place the way the exit status is — see `publish` in `journal.ts`, where
      // the `mv`'s few milliseconds are the difference between a `kill()` that finds the pid
      // and one that refuses to deliver. Anything that is not a positive integer is still
      // treated as "not written yet" rather than guessed at.
      return Number.isInteger(pid) && pid > 0 ? pid : undefined
    },
    readSliceFrom: async (path: string, offset: number) => host.readSlice(path, offset),
    readEndOffset: async (path: string) => await host.size(path) ?? 0,
    async* streamFile(path: string, offset = 0) {
      let at = offset
      while (true) {
        const { data, total } = await host.readSlice(path, at, CHUNK_BYTES)
        if (data.length === 0) {
          return
        }
        at += data.length
        yield data
        if (at >= total) {
          return
        }
      }
    },
  }
}
