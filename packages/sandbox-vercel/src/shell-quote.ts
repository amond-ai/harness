/**
 * argv → one POSIX shell word list, and back.
 *
 * A copy of `@amond-ai/sandbox-e2b`'s module of the same name rather than an import of it: the
 * backends are peers, and a Vercel provider that depended on the e2b one would drag the e2b SDK
 * into a package that never talks to e2b. The rule is the same conservative one — wrap every
 * argument in single quotes, where the shell interprets nothing at all, and handle the single
 * character that can end the quoting (`'` → `'\''`) — and it matters here for the same reason:
 * the contract passes commands as argv (`SandboxCommand`) precisely so a prompt can travel as
 * one element, and the journal wrapper is a shell script, which is where that guarantee would
 * otherwise stop holding.
 *
 * **There is exactly one layer of quoting in this backend, and that is the difference from
 * e2b's copy.** `runCommand` takes an executable plus an argv array (`{ cmd: 'setsid', args:
 * ['--wait', 'sh', '-c', script] }`), so the script reaches the sandbox as one argument the SDK
 * transports verbatim — nothing re-parses it on the way. e2b's `commands.run` takes a *string*,
 * which forces a second layer over the first and a matching double-peel on the way back
 * (`journalledScriptIn`, `unquotedIndexOf`); none of that exists here, and neither does the
 * class of failure it was written for. What remains is the quoting {@link journalledScript}
 * puts *inside* the script, and {@link unquoteArgv}, which reads it back out of a command line
 * when the record naming the process is gone.
 */

/** Quote one argument so the shell reads it as a single literal word. */
export function quoteArg(arg: string): string {
  return `'${arg.replaceAll(`'`, `'\\''`)}'`
}

/**
 * Quote a whole argv.
 *
 * An empty argv throws rather than producing an empty string: handed to `sh -c`, that would run
 * *something else* — the journal's redirection and bookkeeping alone — and report success,
 * which is the silent-success failure mode the bridge and worker-native paths both guard
 * against.
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
 * What recovery reads. A journal meta is written after the command starts — the Vercel command
 * id is not known before it — and the turn itself can delete its own, while the wrapper's
 * command line still carries the argv written down inside the script. Without this,
 * `parseJournalScript` cannot say *what* a discovered process is running, and a caller matching
 * a recovered turn against the argv it is about to start would start a second `claude` in the
 * same checkout.
 *
 * Deliberately narrow: it accepts only what {@link quoteArgv} emits — whole words built from
 * single-quoted segments and `\'` escapes — and answers `undefined` for anything else rather
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
    if (quoted[at] !== `'`) {
      // Bare text outside quotes. `quoteArg` wraps every argument, so this is not our output
      // and reading it as one word would invent an argv nobody ran.
      return undefined
    }
    let word = ''
    while (at < quoted.length && quoted[at] === `'`) {
      const closed = quoted.indexOf(`'`, at + 1)
      if (closed < 0) {
        return undefined
      }
      word += quoted.slice(at + 1, closed)
      at = closed + 1
      // `'\''` — the escape `quoteArg` emits for a quote — reopens immediately after it, so an
      // argument containing one is several quoted segments rather than a single pair. Stopping
      // at the first closing quote would truncate it.
      if (quoted.startsWith(`\\''`, at)) {
        word += `'`
        at += 2
      }
    }
    if (at < quoted.length && quoted[at] !== ' ') {
      return undefined
    }
    argv.push(word)
  }
  return argv.length > 0 ? argv : undefined
}
