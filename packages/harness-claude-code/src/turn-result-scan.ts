/**
 * The turn's verdict, read off the stream while the turn is still running.
 *
 * The settle-time replay parses a *window* of decoded messages (`parseTurnResult`); the attempt
 * loop has no window. What both drivers do have is the turn's NDJSON going past them — the `cli`
 * driver counts its process log's bytes for liveness, the `sdk` driver receives one `raw` frame
 * per SDK message — so the verdict is scanned out of that same traffic rather than re-read
 * afterwards (#376).
 *
 * **The line rules are `decodeNdjson`'s, deliberately, and not a second set.** That decoder is
 * what the settle path reads the very same bytes with, so a line the two disagree about would be
 * a run whose loop and whose row were judged on different evidence. Three rules travel with it:
 * a line is reassembled across chunk boundaries however the transport split it, a line that will
 * not parse is skipped rather than fatal, and **a final line with no newline terminator is still
 * a line** — `decodeNdjson` flushes and parses its trailing buffer, and a `result` is the last
 * thing a turn writes, so refusing the unterminated tail would drop exactly the message this
 * exists to read. No length bound of its own, for the same reason: the decoder has none, and one
 * here would make the reading depend on where the transport happened to cut.
 *
 * Anything after the result is noise — a host appends `sandbox-log` frames after a turn ended,
 * and a resumed journal holds an earlier turn's result before this one's — so the scan keeps the
 * *last* readable result, as `parseTurnResult` searches from the end.
 *
 * Import-free apart from the parse it delegates to, so `bun test` reaches it without workerd.
 */
import type { TurnVerdict } from './outcome'
import type { AttemptResult } from './turn-driver'
import { isResultMessage, turnResultSchema, turnVerdict } from './turn-result'

/**
 * A stateful scan over one turn's NDJSON, in whichever pieces its driver sees it.
 *
 * `verdict` is a getter rather than a returned value because the answer changes as the turn runs
 * and the caller reads it at the end — after the last drain, when the result line has certainly
 * gone past. It reads the unterminated tail as well, so a caller that asks mid-turn is answered
 * from a complete line or not at all.
 */
export interface TurnResultScanner {
  /** Feed one chunk of the turn's stdout, as the log cursor delivered it. */
  push: (chunk: Uint8Array) => void
  /** Feed text already assembled — a `raw` frame's line, or a resumed mirror's stored record. */
  text: (text: string) => void
  /** The last readable `result` the scan has seen, projected to what the loop may read. */
  verdict: () => TurnVerdict | undefined
}

export function createTurnResultScanner(seed?: TurnVerdict): TurnResultScanner {
  const decoder = new TextDecoder()
  let pending = ''
  let last = seed

  function consume(chunk: string): void {
    pending += chunk
    let newline = pending.indexOf('\n')
    while (newline !== -1) {
      take(pending.slice(0, newline))
      pending = pending.slice(newline + 1)
      newline = pending.indexOf('\n')
    }
  }

  function take(line: string): void {
    const parsed = parseResultLine(line)
    if (parsed !== undefined) {
      last = parsed
    }
  }

  return {
    push(chunk: Uint8Array): void {
      // `stream: true` so a multi-byte character split across two chunks is held by the decoder
      // rather than decoded as two replacement characters inside a line the scan still has to
      // read — the same `{ stream: true }` the settle decoder feeds its buffer with.
      consume(decoder.decode(chunk, { stream: true }))
    },
    text(value: string): void {
      consume(value)
    },
    // The trailing buffer, read the way `decodeNdjson` reads its own: a turn whose last line
    // never got its newline still ended with that line.
    verdict: () => parseResultLine(pending) ?? last,
  }
}

/**
 * One NDJSON line as a verdict, or `undefined` for every line that is not a readable result.
 *
 * Deliberately silent about a line it cannot read, unlike `parseTurnResult`: this runs over
 * *every* line of a turn's transcript, and a warning per non-result line would be the log. The
 * settle replay parses the same message again with the schema that warns, so drift is still said
 * once — there, where the run's own verdict depends on it.
 */
function parseResultLine(text: string): TurnVerdict | undefined {
  const trimmed = text.trim()
  if (trimmed === '') {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  }
  catch {
    return undefined
  }
  if (!isResultMessage(parsed)) {
    return undefined
  }
  const result = turnResultSchema.safeParse(parsed)
  return result.success ? turnVerdict(result.data) : undefined
}

/**
 * Carry a scanned verdict onto the attempt's result, where the result has a place for one.
 *
 * A timeout and a deferral do not, and that is the union's own statement rather than this
 * function's caution ({@link AttemptResult}): a turn a timer ended is not described by whatever
 * `result` line it managed to print first, and a deferral is a question this side has to route
 * rather than an ending to judge. So a verdict scanned on either path is dropped here rather than
 * being made unreachable at the producer — both drivers scan the same stream, and only the ending
 * decides whether the reading is admissible.
 */
export function withVerdict(result: AttemptResult, verdict: TurnVerdict | undefined): AttemptResult {
  if (verdict === undefined || result.outcome === 'timed-out' || result.outcome === 'deferred') {
    return result
  }
  return { ...result, verdict }
}
