/**
 * argv → one POSIX shell word list, and back.
 *
 * The contract passes commands as argv (`SandboxCommand`) because that is what the Cloudflare
 * backend takes, and `claude-argv.ts` states the consequence outright: the prompt travels as a
 * single argv element, so "no shell escaping needed". Every other backend hands a turn to a
 * shell script at some point — e2b's `commands.run` and Daytona's session API take a *string*,
 * and the local and Vercel journal wrappers are scripts themselves — so that guarantee stops
 * holding at that boundary and this module is what restores it.
 *
 * The rule is the conservative one: wrap every argument in single quotes, where the shell
 * interprets nothing at all, and handle the single character that can end the quoting — `'`
 * itself — by closing the quote, emitting an escaped quote, and reopening (`'` → `'\''`).
 * Newlines, `$`, backticks, `;` and `&&` all survive verbatim inside the quotes, which matters
 * because an issue title or body reaches `claude -p` as one argument and is attacker-influenced
 * text.
 *
 * It lives in the contract package because four backends implement it, and four copies had
 * already diverged once: the NUL-byte check below existed only in the local backend's, so the
 * other three let the byte through to an SDK that failed on it with an error naming nothing the
 * caller wrote. A quoting fix belongs in one place. How many layers of quoting a backend stacks
 * on top of this rule — e2b two, Vercel one, Daytona one and no reading back — is the backend's
 * own business and is documented beside the code that relies on it.
 */

/**
 * Quote one argument so the shell reads it as a single literal word.
 *
 * A NUL byte throws rather than being quoted: there is no shell spelling for one, and whatever
 * carries the script onward — `spawn`'s argument list, an SDK's request — rejects the whole
 * call with a diagnosis about the script, several layers away from the argv element or path
 * that actually carries the byte. {@link role} is what closes that distance, so the caller is
 * told which one at the boundary that knows.
 */
export function quoteArg(arg: string, role = 'an argument'): string {
  if (arg.includes('\0')) {
    throw new Error(`cannot quote ${role} containing a NUL byte: the command runs through a shell script, and a script cannot spell one`)
  }
  return `'${arg.replaceAll(`'`, `'\\''`)}'`
}

/**
 * Quote a whole argv.
 *
 * An empty argv throws rather than producing an empty string: handed to `sh -c`, that would run
 * *something else* — the wrapper's redirection and bookkeeping alone — and report success,
 * which is the silent-success failure mode the bridge and worker-native paths both guard
 * against.
 */
export function quoteArgv(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw new Error('cannot quote an empty argv: there is no command to run')
  }
  return argv.map((arg, index) => quoteArg(arg, `argv[${String(index)}]`)).join(' ')
}

/**
 * One quoted word list back to argv — the inverse of {@link quoteArgv}.
 *
 * What recovery reads. A process record can be missing while its process is still running —
 * it is written after the spawn, and the turn itself can delete its own — and the wrapper's
 * command line, wherever the backend can still see it, carries the argv that was written down
 * inside the script. Without this, a caller matching a recovered turn against the argv it is
 * about to start cannot say what the discovered process is running, and would start a second
 * `claude` in the same checkout.
 *
 * Deliberately narrow: it accepts only what {@link quoteArgv} emits — whole words built from
 * single-quoted segments and `'\''` escapes — and answers `undefined` for anything else rather
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
 * The first quoted word at `from`, and the offset just past it — {@link quoteArg} inverted over
 * a prefix rather than a whole line.
 *
 * Exported because a wrapper's command line is not always an argv: a backend may write a path
 * as one quoted word followed by redirections (`… ; } > '<path>' 2> '<path>'`) and read it back
 * out of exactly that word. It has to be scanned by the rule `quoteArg` writes by, because that
 * rule does not keep an argument in one pair of quotes: `it's` is emitted as `'it'\''s'`.
 * Stopping at the first closing quote would truncate a path containing a `'` (cubic review, PR
 * #260).
 *
 * `undefined` for anything {@link quoteArg} never emits — bare text, an unterminated quote, or
 * an escaped quote that does not reopen the quoting.
 */
export function unquoteFirstArg(quoted: string, from = 0): { value: string, end: number } | undefined {
  if (quoted[from] !== `'`) {
    // Bare text outside quotes. `quoteArg` wraps every argument, so this is not our output and
    // reading it as one word would invent an argv nobody ran.
    return undefined
  }
  let value = ''
  let at = from
  while (quoted[at] === `'`) {
    const closed = quoted.indexOf(`'`, at + 1)
    if (closed < 0) {
      return undefined
    }
    value += quoted.slice(at + 1, closed)
    at = closed + 1
    // `'\''` — the escape `quoteArg` emits for a quote — reopens immediately after it, so an
    // argument containing one is several quoted segments rather than a single pair.
    if (quoted.startsWith(`\\''`, at)) {
      value += `'`
      at += 2
    }
  }
  if (at < quoted.length && quoted[at] !== ' ') {
    return undefined
  }
  return { value, end: at }
}
