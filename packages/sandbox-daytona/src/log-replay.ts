/**
 * Daytona's command logs → `ProcessLogEvent`s, which is what the contract's `logs()` returns.
 *
 * Kept pure — a snapshot in, events out — so the projection can be exercised without a sandbox.
 * Fetching the logs is the session's job.
 *
 * The cursor encodes how far each stream has been served (`"<stdoutBytes>:<stderrBytes>"`), in
 * **bytes**, exactly as the e2b backend's does. It is opaque to callers: `readLogSample` in the
 * run workflow only ever round-trips it back through `since`, and an unparseable one is read as
 * the start rather than rejected, because a replay that silently returns nothing would read as a
 * wedged turn (AC-026).
 *
 * Bytes rather than UTF-16 code units even though Daytona hands back *strings*, and that is the
 * one place this differs from its sibling. `ProcessLogEvent.data` is a `Uint8Array` and the
 * consumer downstream is `demuxProcessEvents` feeding an NDJSON parser, so the encode has to
 * happen anyway; positioning in the encoded bytes is what makes a resumed read start on the byte
 * after the last one served. Slicing the string instead would drift from the cursor the moment a
 * turn printed a non-ASCII character — a Korean issue title is three bytes and one code unit —
 * and the drift would show up as a truncated NDJSON line rather than as an error.
 *
 * A terminal event is emitted only for an unpositioned read (`since` absent). Those are the
 * whole-transcript reads — `replayTurn` — that exist to learn how the turn ended. A positioned
 * read is the watchdog sampling liveness, which counts bytes and ignores terminal events, so
 * re-serving one on every tick would be noise at best and a double-counted exit at worst.
 */
import type { ProcessLogEvent } from '@amond-ai/sandbox'

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
  // becomes `Infinity`, and a positioned read from `Infinity` drops the whole transcript rather
  // than reading it from the start as this function promises for a cursor it cannot make sense
  // of.
  if (!Number.isSafeInteger(stdout) || !Number.isSafeInteger(stderr)) {
    return start
  }
  return { stdout, stderr }
}

/** One stream's contribution to a positioned read. */
export interface LogSlice {
  /** Bytes at or after the cursor. */
  data: Uint8Array
  /** The stream's full byte length. What the next cursor encodes, and never `data.length`. */
  total: number
}

/**
 * A Daytona log string, positioned at a byte offset.
 *
 * The encode is unavoidable — see the module docblock — so the offset is applied to the encoded
 * bytes. An offset that lands *inside* a multi-byte character produces a slice starting
 * mid-character, which is correct rather than unfortunate: the caller is resuming a byte stream
 * it was handed the position of, and re-serving the character's leading bytes would duplicate
 * output the previous read already delivered.
 *
 * An offset past the end answers with nothing rather than throwing. Daytona retains a command's
 * logs after it exits, so that case is a caller resuming a cursor from a stream that has not
 * grown since — the ordinary shape of a watchdog sample against an idle turn.
 */
export function sliceFrom(text: string | undefined, offset: number): LogSlice {
  const bytes = new TextEncoder().encode(text ?? '')
  return { data: bytes.subarray(Math.min(Math.max(offset, 0), bytes.length)), total: bytes.length }
}

/**
 * Events for a read the caller has already positioned.
 *
 * The cursor encodes the streams' full lengths, not how much was served — it is a position in
 * the log, and `data.length` is only the part that came after the last one. No terminal event,
 * for the reason the module docblock gives.
 */
export function replayPositioned(
  slices: { stdout: LogSlice, stderr: LogSlice },
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
