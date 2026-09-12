/**
 * argv → one POSIX shell word list, and back.
 *
 * A copy of `@amond-ai/sandbox-e2b`'s module of the same name rather than an import of it:
 * the two backends are peers, and a local provider that dependend on the e2b one would drag
 * the e2b SDK into a desktop app that never talks to e2b. The rule it implements is the same
 * conservative one — wrap every argument in single quotes, where the shell interprets
 * nothing, and handle the single character that can end the quoting (`'` → `'\''`) — and it
 * matters here for the same reason: the contract passes commands as argv precisely so a
 * prompt can travel as one element, and the journal wrapper is a shell script, which is where
 * that guarantee would otherwise stop holding.
 */

/** Quote one argument so the shell reads it as a single literal word. */
export function quoteArg(arg: string): string {
  return `'${arg.replaceAll(`'`, `'\\''`)}'`
}

/**
 * Quote a whole argv.
 *
 * An empty argv throws rather than producing an empty string: handed to `sh -c`, that would
 * run the redirection wrapper alone and report success — a command that never ran, reported
 * as one that ran fine.
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
 * What recovery reads. A process record can be missing while its process is still running —
 * the record is written after the spawn, and on a backend with no filesystem boundary the
 * command itself can delete it — and the host's process table still carries the wrapper's
 * command line, which is where the argv was also written down.
 *
 * Deliberately narrow: it accepts only what {@link quoteArgv} emits and answers `undefined`
 * for anything else, rather than guessing at a shell grammar this module never produces.
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
      // `'\''` — the escape `quoteArg` emits for a quote — reopens immediately after it.
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
