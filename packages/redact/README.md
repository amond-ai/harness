# @amond-ai/redact

Masks credential shapes out of a diagnostic before it is logged, stored or shown — **one list
of shapes, shared by every sink**.

A masker that only one sink knows about is a shape every other sink misses. The turn driver
logs to the console, journals to the sandbox filesystem, persists an error summary to the
orchestrator's store and renders one to a dashboard; each of those is a place a bearer token
pasted into a prompt or echoed by a failing command can surface. They all reach for the list
here.

```ts
import { sanitizeDiagnostic, sanitizeErrorSummary } from '@amond-ai/redact'

// The protected values are the ones that carry no shape of their own — an
// operator-typed webhook secret is whatever they typed.
console.error(sanitizeDiagnostic(stderr, [webhookSecret], 2_000))

await store.put(runId, { error: sanitizeErrorSummary(stderr) })
```

## What it covers

| Export | Signature |
| --- | --- |
| `maskSecretShapes` | `(text)` — the shape list, applied to one string |
| `maskCredentialLines` | `(text)` — the shapes, plus the line-level `name=value` rule |
| `maskPersistedText` | `(raw)` — the line rule for durable text; `null` for blank input |
| `sanitizeDiagnostic` | `(diagnostic, protectedValues, maxLength)` — protected values, then shapes, then the bound |
| `sanitizePersistedDiagnostic` | the same three arguments, with the line rule instead of the shapes alone |
| `describeCause` | `(cause)` — an `unknown` thrown value, described and bounded by `DESCRIBED_CAUSE_MAX_LENGTH` |
| `sanitizeErrorSummary` | `(raw)` — the stored summary path, bounded by `SUMMARY_MAX_LENGTH` |
| `REDACTED` | the replacement token, so a test asserts on a constant rather than a literal |

## Why the order inside each pass is fixed

**Mask before the final cut.** Shortening the text first can pull an unmasked fragment across
the truncation boundary — the tail of a token that was going to be replaced ends up inside the
part that is kept. So every bounded entry point masks first and slices second.

**But never scan unbounded input.** `sanitizeErrorSummary` can be handed megabytes of
accumulated stderr for a 500-character column. It bounds the raw text to 64 KiB *before*
redaction, which is generous enough that no realistic log line is cut by it, and turns an
unbounded scan into a bounded one.

**One `maskSecretShapes` run per pass.** Chaining two masking passes is its own defect: the
second pass cuts the first one's replacements in half. `sanitizePersistedDiagnostic` exists so
the union of the protected values and the name rule is one pass rather than two calls at a call
site.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
