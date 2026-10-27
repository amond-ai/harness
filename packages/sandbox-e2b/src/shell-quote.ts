/**
 * The half of e2b's quoting that only its double layer needs.
 *
 * `quoteArg`, `quoteArgv`, `unquoteArgv` and `unquoteFirstArg` live in `@amond-ai/sandbox/journal`:
 * every backend that hands a command to a shell quotes through the first two (Cloudflare passes
 * argv natively and quotes nothing), and only the ones that read a command line back use the
 * readers (Daytona has none). What stays here exists because e2b's
 * `commands.run` takes a *string*: the journal wrapper quotes the argv, then quotes that whole
 * script again as one word (`journalledScriptIn`), so recovering anything from a process table
 * means peeling two layers, and finding a marker means knowing which layer it sits in.
 */
/**
 * The first occurrence of `needle` *outside* quoting, or `-1` — `quoteArg`'s grammar
 * applied to a search rather than to a read.
 *
 * `indexOf` is not this. Everything `quoteArgv` emits is inside quotes, so a caller
 * looking for a marker it wrote itself finds the argv's copy instead whenever its own marker
 * is absent — which is exactly the case a journal wrapper written before the marker existed
 * presents (`journalledScriptIn`, PR #276).
 *
 * The scan is not a `'` toggle either, and that is the whole reason it lives beside
 * `unquoteFirstArg` rather than being written wherever it is needed. `quoteArg` emits
 * `it's` as `'it'\''s'`, so between two quoted segments there is a `\'` that is an escaped
 * quote *outside* quoting: consumed as two characters, or the scan finishes with its state
 * inverted and reports matches inside quotes as top-level ones. It mirrors that reading
 * rather than sharing it because the two answer different questions — this one walks past
 * bare text that `unquoteFirstArg` refuses outright.
 */
export function unquotedIndexOf(text: string, needle: string): number {
  let at = 0
  let quoted = false
  while (at < text.length) {
    if (!quoted && text.startsWith(needle, at)) {
      return at
    }
    if (text[at] === `'`) {
      quoted = !quoted
      at++
    }
    else if (!quoted && text.startsWith(`\\'`, at)) {
      at += 2
    }
    else {
      at++
    }
  }
  return -1
}
