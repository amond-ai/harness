/**
 * Journal files → `ProcessLogEvent`s, which is what the contract's `logs()` returns.
 *
 * Kept pure — snapshot in, events out — so the projection can be exercised without a
 * sandbox. Reading the files is the session's job.
 *
 * The cursor encodes how far each stream has been served (`"<stdoutBytes>:<stderrBytes>"`).
 * It is opaque to callers: `readLogSample` in the run workflow only ever round-trips it
 * back through `since`, and an unparseable one is read as the start rather than rejected,
 * because a replay that silently returns nothing would read as a wedged turn (AC-026).
 *
 * A terminal event is emitted only for an unpositioned read (`since` absent). Those are the
 * whole-transcript reads — `replayTurn` — that exist to learn how the turn ended. A
 * positioned read is the watchdog sampling liveness, which counts bytes and ignores
 * terminal events, so re-serving one on every tick would be noise at best and a
 * double-counted exit at worst.
 */
import type { ProcessLogEvent } from '@pleaseai/sandbox-contract'

export function encodeCursor(stdout: number, stderr: number): string {
  return `${stdout}:${stderr}`
}

export function decodeCursor(cursor?: string): { stdout: number, stderr: number } {
  const start = { stdout: 0, stderr: 0 }
  if (cursor === undefined) {
    return start
  }
  const match = /^(\d+):(\d+)$/.exec(cursor)
  if (!match) {
    return start
  }
  const stdout = Number(match[1])
  const stderr = Number(match[2])
  // Well-formed is not the same as representable: 400 digits of `9` matches the pattern and
  // becomes `Infinity`, and a positioned read from `Infinity` drops the whole transcript
  // rather than reading it from the start as this function promises for a cursor it cannot
  // make sense of (cubic review, PR #260).
  if (!Number.isSafeInteger(stdout) || !Number.isSafeInteger(stderr)) {
    return start
  }
  return { stdout, stderr }
}

/** One stream's contribution to a positioned read. */
export interface JournalSlice {
  /** Bytes at or after the cursor — positioned by the reader, not sliced here. */
  data: Uint8Array
  /** The file's full length. What the next cursor encodes, and never `data.length`. */
  total: number
}

/**
 * Events for a read the caller has already positioned.
 *
 * Separate from {@link replayEvents} because the two reads want opposite things from the
 * journal. An unpositioned read is `replayTurn` asking for the whole transcript and how the
 * turn ended, so holding all of it is inherent — and it happens once. A positioned read is
 * the watchdog sampling liveness every few seconds for the length of a turn: it needs only
 * what arrived since last time, and taking the whole file to slice the tail off it made
 * each sample cost O(total transcript) in a 128MB isolate, so a healthy turn could fail
 * purely because its output grew (codex review, PR #260).
 *
 * The cursor still encodes the files' full lengths, not how much was served — it is a
 * position in the journal, and `data.length` is only the part that came after the last one.
 * No terminal event, for the reason the module docblock gives.
 */
export function replayPositioned(
  slices: { stdout: JournalSlice, stderr: JournalSlice },
  at: string,
): ProcessLogEvent[] {
  const cursor = encodeCursor(slices.stdout.total, slices.stderr.total)
  const events: ProcessLogEvent[] = []
  if (slices.stdout.data.length > 0) {
    events.push({ type: 'stdout', cursor, timestamp: at, data: slices.stdout.data })
  }
  if (slices.stderr.data.length > 0) {
    events.push({ type: 'stderr', cursor, timestamp: at, data: slices.stderr.data })
  }
  return events
}
