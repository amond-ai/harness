/**
 * Bounding and scrubbing a diagnostic on its way into durable storage.
 *
 * Split from {@link maskCredentialLines}'s shapes rather than folded into them: the masking is
 * every sink's, while the two bounds below belong to the summary path alone — a log line is not
 * truncated and has no 500-character column to fit into.
 */
import { maskCredentialLines } from './redact'

/**
 * Ceiling on a run's outcome summary.
 *
 * A summary is a diagnostic, not a log: it travels into tracker-side status writes and
 * (via T006) into durable history, so it is bounded at the boundary rather than trusted
 * to be short. A refusal's reason is the classifier's own sentence and passes the same bound
 * for the same reason — it comes from a model, so nothing upstream caps it either.
 */
export const SUMMARY_MAX_LENGTH = 500

/**
 * Upper bound, in characters, on how much of the raw input the redaction pass ever scans.
 *
 * `runFailure` (`claude-run.ts`) can hand this function megabytes of accumulated stderr, and
 * without a pre-redaction bound the line-split/regex/join pass would scan all of it just to
 * keep the first {@link SUMMARY_MAX_LENGTH} characters. `SUMMARY_MAX_LENGTH * 4` (2000) was
 * considered and rejected: a credential could straddle that boundary, and once the text
 * ahead of it is shortened by redaction, the tail end of a token cut there could slide into
 * the visible first 500 characters. 64 KiB is generous enough that no realistic single log
 * line is truncated by it, while still turning an unbounded scan into a bounded one.
 *
 * The masking itself is `redact.ts`'s (T022) — the shapes and the line-level name rule alike,
 * since {@link maskCredentialLines} was extracted there. This path owns only the two bounds, so
 * a shape added for a log line is a shape the durable summary gets too.
 */
const REDACTION_SCAN_BOUND = 64 * 1024

/**
 * One character a redactable token can be made of — the union of what the shape patterns in
 * `redact.ts` match, so a value split by a hard cut always ends in a run of these.
 *
 * Tested one character at a time on purpose. The anchored run form (`/[\w+/=-]+$/`) backtracks
 * quadratically on the very input this bound exists for — a 64 KiB unbroken run — because every
 * failed `$` retries from the next start offset.
 */
const TOKEN_CHARACTER_PATTERN = /[\w+/=-]/

/**
 * Bound and scrub a diagnostic for durable storage.
 *
 * Redaction runs before truncation so the final {@link SUMMARY_MAX_LENGTH} cut can never cut
 * a secret open mid-value — but redaction itself must not scan an unbounded input first, so
 * the raw text is bounded to {@link REDACTION_SCAN_BOUND} characters *before* redaction runs.
 *
 * Returns `null` for absent or blank input, which is what the nullable column stores.
 */
export function sanitizeErrorSummary(raw: string | null | undefined): string | null {
  if (!raw || raw.trim() === '') {
    return null
  }

  return maskCredentialLines(boundForScan(raw)).slice(0, SUMMARY_MAX_LENGTH)
}

/**
 * Cut `raw` to {@link REDACTION_SCAN_BOUND} without leaving a token fragment behind.
 *
 * The preferred cut is the last newline inside the bound: a token contains no newlines, so
 * dropping whole lines can never split one. That cut is only taken when it still leaves more
 * than {@link SUMMARY_MAX_LENGTH} characters to summarise — a blob whose only newline sits
 * near the start would otherwise be cut down to an empty summary, losing the diagnostic
 * entirely (#75 review).
 *
 * The fallback hard cut can land mid-token, and a fragment shorter than
 * `SECRET_RUN`'s 32-character minimum survives redaction — it could then slide into
 * the stored summary once the text ahead of it collapses to `[redacted]`. Dropping the
 * trailing token-shaped run removes that fragment outright, at the cost of a few benign
 * characters at the 64 KiB mark (#75 review).
 */
function boundForScan(raw: string): string {
  if (raw.length <= REDACTION_SCAN_BOUND) {
    return raw
  }
  const lastNewline = raw.lastIndexOf('\n', REDACTION_SCAN_BOUND)
  if (lastNewline >= SUMMARY_MAX_LENGTH) {
    return raw.slice(0, lastNewline)
  }
  return dropTokenTail(raw.slice(0, REDACTION_SCAN_BOUND))
}

/** Drop the trailing run of token characters, which is where a hard cut leaves a fragment. */
function dropTokenTail(text: string): string {
  let end = text.length
  while (end > 0 && TOKEN_CHARACTER_PATTERN.test(text[end - 1])) {
    end--
  }
  return text.slice(0, end)
}
