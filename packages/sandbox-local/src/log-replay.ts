/**
 * Journal bytes → `ProcessLogEvent`s, kept pure so the projection can be exercised without a
 * filesystem. Reading the files is {@link import('./journal-io').JournalIo}'s job.
 *
 * The cursor encodes how far each stream has been served (`"<stdoutBytes>:<stderrBytes>"`) and
 * is opaque to callers: they only ever round-trip it back through `since`. An unparseable one
 * is read as the start rather than rejected, because a replay that silently returned nothing
 * would read as a wedged turn.
 *
 * A terminal event belongs to an *unpositioned* read — the whole-transcript read that exists
 * to learn how the turn ended. A positioned read is a watchdog counting bytes, which ignores
 * terminal events, so re-serving one every tick would be noise at best and a double-counted
 * exit at worst.
 */
import type { ProcessLogEvent } from '@amond-ai/sandbox'
import type { LocalSlice } from './local-surface'

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
  // becomes `Infinity`, and a read positioned there would drop the whole transcript rather
  // than start from the beginning as this function promises for a cursor it cannot read.
  if (!Number.isSafeInteger(stdout) || !Number.isSafeInteger(stderr)) {
    return start
  }
  return { stdout, stderr }
}

/**
 * Events for a read the caller has already positioned.
 *
 * The cursor encodes the files' full lengths, never how much was served: it is a position in
 * the journal, and `data.length` is only the part that arrived after the last one.
 */
export function replayPositioned(
  slices: { stdout: LocalSlice, stderr: LocalSlice },
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
