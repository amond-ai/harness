/**
 * argv → one POSIX shell word list, safely.
 *
 * The contract passes commands as argv (`SandboxCommand`) because that is what the Cloudflare
 * backend takes, and `claude-argv.ts` states the consequence outright: the prompt travels as a
 * single argv element, so "no shell escaping needed". Daytona's session API accepts a *string*
 * — `executeSessionCommand(sessionId, { command })` — so that guarantee stops holding at this
 * boundary and this module is what restores it.
 *
 * The rule is the conservative one: wrap every argument in single quotes, where the shell
 * interprets nothing at all, and handle the single character that can end the quoting — `'`
 * itself — by closing the quote, emitting an escaped quote, and reopening (`'` → `'\''`).
 * Newlines, `$`, backticks, `;` and `&&` all survive verbatim inside the quotes, which matters
 * because an issue title or body reaches `claude -p` as one argument and is attacker-influenced
 * text.
 *
 * Deliberately quoting-only, unlike the e2b backend's sibling module. That one also carries an
 * *unquoting* parser, because e2b's process table is the only place an exited turn's argv
 * survives and it holds the wrapper's command line as a string. Daytona records the command a
 * session ran on the session itself and its exit code in the toolbox daemon, so nothing here
 * ever has to read a shell word list back into argv.
 */

/** Quote one argument so the shell reads it as a single literal word. */
export function quoteArg(arg: string): string {
  return `'${arg.replaceAll(`'`, `'\\''`)}'`
}

/**
 * Quote a whole argv.
 *
 * An empty argv throws rather than producing an empty string: handed to `sh -c`, that would run
 * *something else* — the pid-recording prefix alone — and report success, which is the
 * silent-success failure mode the bridge and worker-native paths both guard against.
 */
export function quoteArgv(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw new Error('cannot quote an empty argv: there is no command to run')
  }
  return argv.map(quoteArg).join(' ')
}
