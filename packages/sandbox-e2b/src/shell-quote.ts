/**
 * argv → one POSIX shell word list, safely.
 *
 * The contract passes commands as argv (`SandboxCommand`) because that is what the
 * Cloudflare backend takes, and `claude-argv.ts` states the consequence outright: the
 * prompt travels as a single argv element, so "no shell escaping needed". e2b's
 * `commands.run` accepts a *string*, so that guarantee stops holding at this boundary and
 * this module is what restores it.
 *
 * The rule is the conservative one: wrap every argument in single quotes, where the shell
 * interprets nothing at all, and handle the single character that can end the quoting —
 * `'` itself — by closing the quote, emitting an escaped quote, and reopening
 * (`'` → `'\''`). Newlines, `$`, backticks, `;` and `&&` all survive verbatim inside the
 * quotes, which matters because an issue title or body reaches `claude -p` as one argument
 * and is attacker-influenced text.
 */

/** Quote one argument so the shell reads it as a single literal word. */
export function quoteArg(arg: string): string {
  return `'${arg.replaceAll(`'`, `'\\''`)}'`
}

/**
 * Quote a whole argv.
 *
 * An empty argv throws rather than producing an empty string: handed to `sh -c`, that
 * would run *something else* — the redirection wrapper alone — and report success, which
 * is the silent-success failure mode the bridge and worker-native paths both guard against.
 */
export function quoteArgv(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw new Error('cannot quote an empty argv: there is no command to run')
  }
  return argv.map(quoteArg).join(' ')
}

/**
 * One quoted word list back to argv — the inverse of {@link quoteArgv}.
 *
 * A turn can delete its own `<id>.meta.json`, and the journal is the only place the argv was
 * written down. e2b's process listing still carries the wrapper's command line, so this is
 * what recovers *what* a discovered process is running when its meta is gone (PR #260) —
 * without it, `liveTurnProcess` cannot match a recovered turn against the argv it is about
 * to start and would run a second `claude` in the same checkout.
 *
 * Deliberately narrow: it accepts only what {@link quoteArgv} emits — whole words built from
 * single-quoted segments and `\'` escapes — and returns `undefined` for anything else rather
 * than guessing at a shell grammar this module never produces.
 */
export function unquoteArgv(quoted: string): string[] | undefined {
  const argv: string[] = []
  let at = 0
  while (at < quoted.length) {
    if (quoted[at] === ' ') {
      at++
      continue
    }
    const word = unquoteFirstArg(quoted, at)
    if (!word) {
      return undefined
    }
    argv.push(word.value)
    at = word.end
  }
  return argv.length > 0 ? argv : undefined
}

/**
 * The first occurrence of `needle` *outside* quoting, or `-1` — {@link quoteArg}'s grammar
 * applied to a search rather than to a read.
 *
 * `indexOf` is not this. Everything {@link quoteArgv} emits is inside quotes, so a caller
 * looking for a marker it wrote itself finds the argv's copy instead whenever its own marker
 * is absent — which is exactly the case a journal wrapper written before the marker existed
 * presents (`journalledScriptIn`, PR #276).
 *
 * The scan is not a `'` toggle either, and that is the whole reason it lives beside
 * {@link unquoteFirstArg} rather than being written wherever it is needed. `quoteArg` emits
 * `it's` as `'it'\''s'`, so between two quoted segments there is a `\'` that is an escaped
 * quote *outside* quoting: consumed as two characters, or the scan finishes with its state
 * inverted and reports matches inside quotes as top-level ones. It mirrors that reading
 * rather than sharing it because the two answer different questions — this one walks past
 * bare text that {@link unquoteFirstArg} refuses outright.
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

/**
 * The first quoted word at `from`, and the offset just past it — {@link quoteArg} inverted
 * over a prefix rather than a whole line.
 *
 * Exported because a journal wrapper's command line is not an argv: `journalledCommand`
 * writes the stdout path as one quoted word followed by redirections (`… ; } > '<path>' 2>
 * '<path>'`), and the recovery reads a process's id back out of exactly that word. It has to
 * be scanned by the rule `quoteArg` writes by, because that rule does not keep an argument in
 * one pair of quotes: `it's` is emitted as `'it'\''s'`. Stopping at the first closing quote
 * would truncate a journal root containing a `'`, leave the wrapper looking like it belonged
 * to no journal, and report a running turn as gone (cubic review, PR #260).
 *
 * `undefined` for anything {@link quoteArg} never emits — bare text, or an unterminated quote.
 */
export function unquoteFirstArg(quoted: string, from = 0): { value: string, end: number } | undefined {
  let value = ''
  let quotedWord = false
  let at = from
  while (at < quoted.length && quoted[at] !== ' ') {
    if (quoted[at] === `'`) {
      const end = quoted.indexOf(`'`, at + 1)
      if (end < 0) {
        return undefined
      }
      quotedWord = true
      value += quoted.slice(at + 1, end)
      at = end + 1
    }
    else if (quoted.startsWith(`\\'`, at)) {
      value += `'`
      at += 2
    }
    else {
      // Bare text outside quotes. `quoteArg` wraps every argument, so this is not our
      // output and reading it as one word would invent an argv nobody ran.
      return undefined
    }
  }
  return quotedWord ? { value, end: at } : undefined
}
