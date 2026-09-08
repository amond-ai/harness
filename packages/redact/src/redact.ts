/** What a protected value is replaced with in a diagnostic. */
export const REDACTED = '[redacted]'

/**
 * Every spelling of a line break a diagnostic may carry: emitted as real characters, or
 * escaped by whatever stringified the error on the way to the log.
 */
const LINE_BREAK_SPELLING = /\\r\\n|\\r|\\n|\r\n|[\r\n]/g

/**
 * Anthropic-style keys (`sk-ant-…`), masked wherever they appear.
 *
 * Lives here rather than in `history.ts` so the two maskers share one list of shapes: a
 * pattern that only the durable-summary path knows about is a pattern every log line misses.
 */
const API_KEY_VALUE_PATTERN = /\bsk-[\w-]{8,}/g

/**
 * GitHub's own token shapes — installation (`ghs_`), user/app (`gho_`, `ghp_`, `ghu_`, `ghr_`),
 * and fine-grained PATs (`github_pat_`).
 *
 * Named explicitly rather than left to {@link SECRET_RUN}, because the run's decision is not a
 * matter of length: `_` puts a token outside {@link OPAQUE_CLASS}, so what is left is
 * {@link isRandomBase64url}'s mixed-case-and-two-digits test, and a token that happens to draw
 * fewer than two digits fails it. Sixteen characters after a known prefix needs no such test.
 * Found in T016, where a realistically shaped `ghs_` token passed the summariser whole — then
 * because `\b` never lands after `ghs_` at all, which is a stronger form of the same miss.
 *
 * Widening {@link OPAQUE_CLASS} to include `_` was rejected: case-insensitively it would
 * swallow any long SCREAMING_SNAKE identifier and gut the diagnostics this exists to keep
 * readable.
 */
const GITHUB_TOKEN_PATTERN = /\b(?:gh[a-z]|github_pat)_\w{16,}/g

/**
 * A dot-separated assertion — three base64url segments — masked as one value.
 *
 * The RS256 JWT the App signs to mint an installation token is base64url, and a `.` is outside
 * {@link SECRET_RUN}'s class, so without this shape the assertion is three separate runs, each
 * judged on its own by a discriminator any one of them may fail. What survived when the opaque
 * class was the only judge was not a fragment either — measured on real 2048-bit assertions,
 * the median run left verbatim was half the token and whole signature segments came through
 * untouched.
 *
 * Widening {@link OPAQUE_CLASS} to cover them was rejected for the same reason it was rejected
 * for GitHub's tokens above: case-insensitively it would swallow any long SCREAMING_SNAKE
 * identifier and gut the diagnostics this exists to keep readable. A shape with three segments
 * and two dots is specific enough to name on its own, and it runs *first* of the four so an
 * assertion collapses to one `[redacted]` instead of being eaten a segment at a time.
 *
 * Sixteen characters per segment is well under what a real assertion carries — a header is ~36,
 * a payload 60 or more, a 2048-bit signature 342 — and past the reach of a short dotted
 * identifier: `a.b.c` and an ordinary package name do not come near it.
 *
 * It is not past the reach of every dotted name, and the docblock that claimed so was wrong.
 * Three 16-character labels in a row are enough, and a hostname supplies them:
 * `reallylongsubdomainname.anotherreallylongdomain.somereallylongtld` is masked whole
 * (verified). That over-masking is the price of the shape, and it is the direction to err in —
 * a diagnostic that lost a long hostname is still legible, and one that carried a signed
 * assertion is a credential in D1.
 */
const JWT_ASSERTION_PATTERN = /(?<![\w-])[\w-]{16,}\.[\w-]{16,}\.[\w-]{16,}(?![\w-])/g

/**
 * One unbroken run over the union of *both* base64 alphabets, matched whole so the decision
 * about it is taken once, in code, by {@link isOpaqueOrRandom}.
 *
 * The blind spot {@link JWT_ASSERTION_PATTERN} closed only half of: a base64url secret with no
 * dots — a gateway `ANTHROPIC_AUTH_TOKEN`, or a `GITHUB_WEBHOOK_SECRET` from a tool that emits
 * the URL-safe alphabet *in mixed case* — matches no prefix, so it reached a log line verbatim.
 * Measured over 2 000 trials per size against the patterns as they then stood: 64% of
 * 32-character secrets fully unmasked, 57% at 43, 45% at 64, 37% at 86.
 *
 * One run rather than two passes, and that is the load-bearing part. The two alphabets overlap
 * and disagree on four characters: `+` and `/` are standard base64's, `-` and `_` are
 * base64url's. A pass per alphabet cuts every value the other one owns in half — the first pass
 * masks the run up to the first character it does not know, and the remainder is a fresh run
 * too short for the second pass to reach. Both orders were measured against the same draws,
 * 20 000 per size, counting an 8-character contiguous fragment of the original surviving:
 *
 * | order                       | std 44c | std 64c | std 88c | url 32c | url 43c | url 64c |
 * |-----------------------------|---------|---------|---------|---------|---------|---------|
 * | base64url run, then opaque  |  10.11% |  49.87% |  44.79% |   2.07% |   0.45% |   0.02% |
 * | opaque, then base64url run  |   0.00% |   0.00% |   0.00% |   2.07% |   7.17% |  33.76% |
 * | **one run, decided once**   | **0.00%** | **0.00%** | **0.00%** | **2.07%** | **0.48%** | **0.02%** |
 *
 * The first row is not hypothetical: it shipped, and against a real 2048-bit key ten of
 * twenty-five PEM body lines reached `error_summary` carrying 260 characters of key material.
 * Reordering only moves the damage onto the other alphabet, which is why neither pass survives.
 *
 * The 0.48% is 0.03 points above the first row rather than equal to it, and the difference is
 * the price of judging the run as a unit: `{@link OPAQUE_CLASS}` is anchored, so a base64url
 * run that fails {@link isRandomBase64url} is now left whole where an unanchored opaque pattern
 * would have masked the longest `[a-z0-9]`-only stretch inside it. Measured directionally over
 * 200 000 draws that is 105 draws at 43 characters and 6 at 64, against zero the other way.
 * Unanchoring it to win them back is the two-pass bug by another route — it is exactly the
 * prefix match that produced the middle row — so the anchor stays.
 *
 * Matching the run and counting its characters is also what keeps this linear. The single-regex
 * form of the entropy test is a chain of unbounded lookaheads (`(?=[\w-]*[a-z])…`), and each of
 * those rescans forward from every start position — quadratic on exactly the long
 * word-character runs this exists to read. Measured to 200 000 characters, on one word-character
 * run, on one run bearing `+` and `/`, and on a text of nothing but 31-character near misses:
 * every doubling of the input doubles the time.
 */
const SECRET_RUN = /(?<![\w+/=-])[\w+/=-]{32,}(?![\w+/=-])/g

/**
 * The standard-base64 (and hex) half of the decision: the whole run is inside the opaque class,
 * padding included. Anchored, because a run is judged as a unit — an unanchored class would put
 * the two-pass bug back by another route, matching the opaque prefix of a base64url run.
 *
 * This is the shape of a token that arrived without a name, which is how a webhook secret or an
 * opaque gateway credential appears in a transport error.
 */
const OPAQUE_CLASS = /^[a-z0-9+/]+={0,2}$/i

/** How much of one caught error may reach a log line. */
export const DESCRIBED_CAUSE_MAX_LENGTH = 2_000

/**
 * Mask every value that merely *looks* like a credential.
 *
 * The counterpart to {@link sanitizeDiagnostic}'s value matching, and the half that most call
 * sites actually need: the code that logs a caught error is almost never the code that holds
 * the secrets, so a masker that only recognises values it was handed leaves every such line
 * unmasked. Shape matching has the opposite failure mode — it cannot see a credential whose
 * shape it does not know — which is why both run, and why every shape lives in this one place.
 */
export function maskSecretShapes(text: string): string {
  // The assertion shape runs first, and the order is load-bearing rather than incidental: it is
  // the most specific of the four and consumes a whole assertion as one match, so nothing it
  // matches is left for the prefix patterns. Run after them, a `ghs_`-prefixed first segment is
  // replaced on its own, which destroys the `seg.seg.seg` shape and leaves the payload and the
  // signature verbatim as base64url the run below would then have to catch a segment at a time.
  const named = text
    .replaceAll(JWT_ASSERTION_PATTERN, REDACTED)
    .replaceAll(API_KEY_VALUE_PATTERN, REDACTED)
    .replaceAll(GITHUB_TOKEN_PATTERN, REDACTED)
  // Last, and once: a value that is neither an assertion nor a named prefix is decided on its
  // whole run, so no earlier decision can leave a tail for a later one to miss.
  return named.replaceAll(SECRET_RUN, run => (isOpaqueOrRandom(run) ? REDACTED : run))
}

/**
 * Credential env-var names: the generic `*_TOKEN` / `*_API_KEY` / `*_SECRET` shape, which
 * covers the credentials this milestone injects and anything else shaped like a secret. The
 * gateway base URL is included explicitly because its name does not follow a generic secret
 * suffix, but its value still identifies protected infrastructure. A line mentioning one is
 * dropped whole — the name alone is enough to suspect the value sits beside it.
 *
 * Lives here rather than in `history.ts` for the reason {@link API_KEY_VALUE_PATTERN} does: the
 * line rule and the shapes are one pass, and a pass split across two modules is a pass one caller
 * gets half of.
 */
const CREDENTIAL_NAME_PATTERN = /\b(?:ANTHROPIC_BASE_URL|[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:TOKEN|API_KEY|SECRET))\b/

/**
 * The masking pass itself, line by line: a line that *names* a credential is dropped whole, and
 * every other line is masked by {@link maskSecretShapes}.
 *
 * The two rules answer different failures, which is why both run. A shape cannot recognise a
 * credential whose shape it does not know — an operator-typed webhook secret is whatever they
 * typed — but an `.env` line carries the name beside it, and the name is enough. Conversely a
 * bare token arrives with no name at all.
 *
 * Runs exactly once over the text, and no caller may run it twice or follow it with
 * {@link maskSecretShapes}: two passes over overlapping character classes cut each other's values
 * in half, which is the defect {@link SECRET_RUN}'s docblock measures. Nothing here bounds or
 * truncates — a caller that needs a length bound applies its own *after* this, so the cut can
 * never land inside a value this pass would otherwise have masked.
 */
export function maskCredentialLines(text: string): string {
  return text
    .split('\n')
    .map(line => (CREDENTIAL_NAME_PATTERN.test(line) ? REDACTED : maskSecretShapes(line)))
    .join('\n')
}

/**
 * Mask free text that is *stored* rather than summarised: {@link maskCredentialLines} with
 * neither of `sanitizeErrorSummary`'s bounds (#205).
 *
 * A cached issue body is a durable surface FR-010/AC-025 governs exactly as it governs
 * `run_history`, so it takes the same masking — but not the same length. The summariser exists to
 * fit a diagnostic into a 500-character column; a body is stored to be read back whole (#179), and
 * a reader has no way to tell a body truncated at 500 characters from one that was that long.
 *
 * No scan bound either, and dropping it is the half that masks *more*. `boundForScan` caps what
 * the summariser reads at 64 KiB because megabytes of stderr can arrive; free text arrives from a
 * tracker, and GitHub caps an issue body at 65 536 characters — one pass over that, once per
 * entity on a write-through, not per read. It also makes the fragment `boundForScan` has to sweep
 * up moot: there is no hard cut to land mid-token, so no sub-32-character remainder to survive.
 *
 * `null` in, `null` out, and blank reads as absent — the contract callers already hold, so an
 * absent body stays absent rather than becoming a masked empty value.
 */
export function maskPersistedText(raw: string | null | undefined): string | null {
  if (!raw || raw.trim() === '') {
    return null
  }

  return maskCredentialLines(raw)
}

/**
 * A diagnostic bound for a **durable** column: {@link sanitizeDiagnostic}'s protected values plus
 * {@link maskCredentialLines}'s name rule, in one pass, then bounded.
 *
 * The union exists because neither half covers the other, and a stored value has to survive both
 * gaps (FR-010, AC-025):
 *
 * - Shape matching cannot see a single-case token carrying `-` or `_`, which
 *   {@link isRandomBase64url} documents and measures. The *name* beside it is what catches those.
 * - The name rule cannot see a bare value that arrived with no name at all — an operator-typed
 *   webhook secret is whatever they typed — which is what the protected values are for.
 *
 * **One `maskSecretShapes` run, and that is the whole reason this is a function rather than two
 * calls at the call site.** `sanitizeDiagnostic` already runs it, and `maskCredentialLines` runs
 * it again: chaining them is exactly the overlapping-pass defect {@link SECRET_RUN}'s docblock
 * measures, where the second pass cuts the first one's values in half. Here the needles are
 * replaced first — a plain substring swap that matches no shape — and the line rule is then the
 * only thing that reaches {@link maskSecretShapes}.
 *
 * Masking is complete before the bound is applied, for {@link sanitizeDiagnostic}'s own reason:
 * shortening a match first could pull an unmasked fragment across the truncation boundary.
 */
export function sanitizePersistedDiagnostic(
  diagnostic: string,
  protectedValues: Iterable<string>,
  maxLength: number,
): string {
  const needles = protectedNeedles(protectedValues)
  const masked = needles.length > 0 ? maskNeedles(diagnostic, needles) : diagnostic
  return maskCredentialLines(masked).slice(0, Math.max(0, maxLength))
}

/** Whether one run is a credential: opaque throughout, or base64url entropy. */
function isOpaqueOrRandom(run: string): boolean {
  return OPAQUE_CLASS.test(run) || isRandomBase64url(run)
}

/**
 * Whether one long base64url run is entropy rather than a name: mixed case, and at least two
 * digits.
 *
 * Chosen by measurement, against 5 000 random base64url secrets per size and every distinct
 * `[\w-]{32,}` run in this app's production sources (17 runs, 14 of them identifiers):
 *
 * | discriminator                    | 32c leak | 43c   | 64c   | 86c   | identifiers masked |
 * |----------------------------------|----------|-------|-------|-------|--------------------|
 * | mixed case                       |    0.00% | 0.00% | 0.00% | 0.00% |              3/14  |
 * | contains `-` or `_`              |   36.72% | 25.3% | 12.4% | 6.48% |             11/14  |
 * | two digits                       |    3.20% | 0.84% | 0.00% | 0.00% |              0/14  |
 * | **mixed case and two digits**    |  **2.90%** | **0.64%** | **0.02%** | **0.00%** | **0/14** |
 * | mixed case and (`-`/`_` or two digits) | 0.72% | 0.06% | 0.00% | 0.00% |         0/14  |
 *
 * What the trade buys and costs: roughly one 32-character secret in thirty-four is still missed
 * — the ones that happen to draw fewer than two digits — and that is the price of not masking
 * names. The last row leaks four times less and was rejected anyway, because on the whole
 * repository (343 runs) it masks 45 of 168 identifiers, `someVeryLongCamelCase_identifierName`
 * among them. Mixed case alone leaks nothing and masks 150 of those 168, which is the same
 * failure at full size. Requiring mixed case rather than digits alone keeps the exemption the
 * rest of this file already rests on: a SCREAMING_SNAKE constant is single-case, so it is never
 * a candidate no matter how many digits it carries.
 *
 * What that costs in coverage, stated narrowly because the sentence here used to overstate it:
 * this catches a base64url secret from an emitter that produces *mixed case*, which random
 * 32-byte entropy always does. It does not catch a single-case token carrying `-` or `_`, and
 * such a token is not exotic — a lowercase or uppercase UUID
 * (`550e8400-e29b-41d4-a716-446655440000`), `correct-horse-battery-staple-for-webhooks`, and
 * `a1_b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0` all pass through (verified). None of them is a
 * regression — none was ever masked — and closing that is what passing the value in to
 * {@link sanitizeDiagnostic} is for.
 *
 * A secret longer than 32 characters is not really at risk here: at 43 — the length 32 bytes of
 * entropy encodes to, which is what both a webhook secret and a gateway token actually are —
 * the miss rate is 0.64%, and it is gone by 64. Those are the discriminator's own figures; end
 * to end through {@link maskSecretShapes} they land at 2.07% / 0.48% / 0.02% / 0.00%, because a
 * run that happens to draw no `-` or `_` is inside {@link OPAQUE_CLASS} after all.
 */
function isRandomBase64url(run: string): boolean {
  let hasLower = false
  let hasUpper = false
  let digits = 0
  for (const character of run) {
    if (character >= 'a' && character <= 'z') {
      hasLower = true
    }
    else if (character >= 'A' && character <= 'Z') {
      hasUpper = true
    }
    else if (character >= '0' && character <= '9') {
      digits += 1
    }
  }
  return hasLower && hasUpper && digits >= 2
}

/**
 * One caught error, as a log line may carry it: masked by shape and bounded.
 *
 * Four identical unmasking copies of this used to exist — in `retry.ts`, `dispatcher-state.ts`,
 * `run-workflow.ts`, and `github-graphql-transport.ts` — feeding nineteen `console.error`
 * interpolations with raw error messages (T022 audit). One definition means a shape added to
 * the list above reaches all of them.
 *
 * Never throws: a log line is not a place a run may fail. A value whose `toString` is hostile
 * still yields a string.
 */
export function describeCause(cause: unknown): string {
  return sanitizeDiagnostic(cause instanceof Error ? cause.message : stringify(cause), [], DESCRIBED_CAUSE_MAX_LENGTH)
}

function stringify(cause: unknown): string {
  try {
    return String(cause)
  }
  catch {
    return '[unprintable]'
  }
}

/**
 * Mask the configured protected values in a diagnostic, then enforce its length bound.
 *
 * Line breaks are normalized away from *both* sides before matching — a copy of the
 * diagnostic and each protected value — so the two never have to agree on how a break is
 * spelled. That covers a value stored with LF against a transport that re-wrote it as CRLF,
 * a key escaped into `\n` by a stringified error, and a break inserted anywhere inside a
 * value by wrapping. Normalizing the haystack rather than widening the needle also keeps
 * the compiled pattern the size of the values themselves; expanding a PEM character by
 * character cost ~100ms to compile, on any input length.
 *
 * Values are matched together, longest first, rather than replaced one by one, so overlapping
 * values cannot expose the unmatched suffix of a longer secret. The complete diagnostic is
 * masked before slicing; therefore shortening an earlier match cannot pull an unmasked secret
 * fragment across the truncation boundary.
 *
 * {@link maskSecretShapes} runs regardless of what was passed, so an empty `protectedValues` is
 * no longer a silent no-op — the shape it used to read as sanitized while masking nothing
 * (`run-prompt.ts`, T022 audit). A caller that holds the values still gains from passing them:
 * shape matching cannot recognise a credential whose shape it does not know.
 */
export function sanitizeDiagnostic(
  diagnostic: string,
  protectedValues: Iterable<string>,
  maxLength: number,
): string {
  const needles = protectedNeedles(protectedValues)
  const masked = needles.length > 0 ? maskNeedles(diagnostic, needles) : diagnostic
  return maskSecretShapes(masked).slice(0, Math.max(0, maxLength))
}

/**
 * The protected values reduced to what is actually matched: line breaks dropped, blanks
 * discarded, longest first. A value that is nothing but line breaks normalizes to empty and
 * is dropped here — matching it would mask the whole diagnostic.
 */
function protectedNeedles(protectedValues: Iterable<string>): string[] {
  const normalized = [...protectedValues].map(value => value.replaceAll(LINE_BREAK_SPELLING, ''))
  return [...new Set(normalized)]
    .filter(value => value.length > 0)
    .sort((left, right) => right.length - left.length)
}

function maskNeedles(diagnostic: string, needles: string[]): string {
  const pattern = new RegExp(needles.map(escapeRegExp).join('|'), 'g')
  const normalized = withoutLineBreaks(diagnostic)
  if (normalized === null) {
    return diagnostic.replaceAll(pattern, REDACTED)
  }

  const { text, origins } = normalized
  let masked = ''
  let copied = 0
  for (const match of text.matchAll(pattern)) {
    const start = origins[match.index]
    const end = origins[match.index + match[0].length - 1] + 1
    masked += diagnostic.slice(copied, start) + REDACTED
    copied = end
  }
  return masked + diagnostic.slice(copied)
}

/**
 * The diagnostic with every line-break spelling removed, plus the origin of each surviving
 * character, so a match found in the copy maps back onto the range it occupies in the
 * original — line breaks the match spans included.
 *
 * `null` when the diagnostic spells no line break at all: it is then its own normal form, and
 * the caller matches it directly rather than paying to index a copy of it character by
 * character. Needles never contain a line break, so the two paths accept the same matches.
 */
function withoutLineBreaks(diagnostic: string): { text: string, origins: number[] } | null {
  const kept: string[] = []
  const origins: number[] = []
  let cursor = 0
  for (const match of diagnostic.matchAll(LINE_BREAK_SPELLING)) {
    keepRange(diagnostic, cursor, match.index, kept, origins)
    cursor = match.index + match[0].length
  }
  if (cursor === 0) {
    return null
  }

  keepRange(diagnostic, cursor, diagnostic.length, kept, origins)
  return { text: kept.join(''), origins }
}

function keepRange(source: string, from: number, to: number, kept: string[], origins: number[]): void {
  for (let index = from; index < to; index++) {
    kept.push(source[index])
    origins.push(index)
  }
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[\\^$.*+?()[\]{}|/]/g, String.raw`\$&`)
}
