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
      const { data } = await host.readSlice(paths.exit, 0)
      if (data.length === 0) {
        // Absent, or created by the shell's redirection a moment before the `printf` lands.
        // Both mean the same thing to every caller: not over yet.
        return undefined
      }
      const code = Number(new TextDecoder().decode(data).trim())
      if (!Number.isInteger(code)) {
        // A partial write, or something else's file. Reporting `undefined` costs a re-read;
        // reporting a `NaN` exit would settle a turn as finished with a code nobody can act on.
        return undefined
      }
      // A shell reports a signalled command as 128+n and this passes that through rather than
      // decoding it: `exit 137` is a legal exit code, so the two are genuinely
      // indistinguishable here, and `ProcessExit.signal` is for a backend that was told.
      return { code, timedOut: await host.exists(paths.timeout) }
    },
    readCommandPid: async (paths: JournalPaths) => {
      const { data } = await host.readSlice(paths.pid, 0)
      const pid = Number(new TextDecoder().decode(data).trim())
      // A partial write reads as a different, still-plausible number, which is why the wrapper
      // writes it with one `printf` of a value it already holds — and why anything that is not
      // a positive integer is treated as "not written yet" rather than guessed at.
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
