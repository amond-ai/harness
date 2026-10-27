/**
 * The process journal — what e2b forgets, written down.
 *
 * Measured behaviour (research note 027): e2b drops a process from `commands.list()` the
 * moment it exits, and `commands.connect(pid)` on an exited pid throws `[not_found]`. The
 * run workflow reads a turn's transcript *after* it exits (`replayTurn`), so the backend
 * has to retain that itself. The Cloudflare container does this natively; here it is four
 * files per process written by the command wrapper and read back through the contract's
 * `logs()`/`status()`/`waitForExit()`.
 *
 * stdout and stderr are separate files rather than one interleaved stream because
 * `ProcessLogEvent` is tagged per stream and `demuxProcessEvents` splits on that tag: the
 * NDJSON turn output must not be polluted by whatever the CLI writes to stderr.
 */
import type { JournalPaths } from '@amond-ai/sandbox/journal'
import { quoteArg, quoteArgv, unquoteFirstArg } from '@amond-ai/sandbox/journal'
import { unquotedIndexOf } from './shell-quote'

// The layout moved into `@amond-ai/sandbox/journal`; re-exported so this module stays the one
// place the rest of the backend (and its tests) import it from.
export { isProcessId, journalPaths, parseJournalMeta, serializeJournalMeta, STDOUT_SUFFIX } from '@amond-ai/sandbox/journal'
export type { JournalMeta, JournalPaths } from '@amond-ai/sandbox/journal'

/** What {@link journalledCommand} brackets the argv with, so it can be read back out. */
export const ARGV_OPEN = '{ '
export const ARGV_CLOSE = ' ; } > '

/**
 * What {@link journalledCommand} starts the journal script under, so the turn owns a session.
 *
 * Measured against a live sandbox (`scripts/spike-e2b-session.ts`, 2026-08-25, template
 * `claude`): a bare wrapper runs as `pid=1568 pgid=511 sid=511` — envd's own session, shared
 * by every command in the sandbox — while under `setsid` it runs as `pid=1579 pgid=1579
 * sid=1579`. That session is what lets `wrapper-table.ts` ask whether anything the turn
 * spawned outlived the wrapper; in the shared session the same question returns envd and
 * every unrelated command, which is why it could not be asked before.
 *
 * `--wait` rather than plain `setsid`, though both measured identically (`setsid --wait`:
 * `pid=1590 pgid=1590 sid=1590`, no fork). It is the safety net for the case the measurement
 * cannot rule out for every future envd: `setsid` forks when its caller is already a process
 * group leader, and a forked plain `setsid` exits immediately, so e2b would track a parent
 * that is already gone and `commands.list()` would report every turn as finished the moment
 * it started — far worse than the hole being closed. With `--wait` the tracked process lives
 * for the wrapped command's real lifetime whichever way envd invokes it.
 *
 * Measured against *this* string, not only against the shape: the spike ran `setsid --wait sh
 * <file>`, and "one quoted argument instead of a path is the same shape" is an inference the
 * whole guard would rest on. Re-run with what `journalledCommand` actually builds — argv
 * `['sh', '-c', 'printf "x\'y" ; sleep 8']`, so the double-escaping is in the string too —
 * `sid === pid` held 3/3, e2b listed the wrapper each time, `pgrep -s <pid>` returned the
 * orphaned child and its `sleep` after a pid-only kill, and an undisturbed run journalled
 * `stdout=x'y exit=0`. The quoting round-trips through a real shell, which is the end of the
 * inference.
 */
export const SESSION_OPEN = 'setsid --wait sh -c '

/**
 * Wrap an argv so its streams and exit status land in the journal — in a session of its own.
 *
 * The argv is grouped (`{ … ; }`) so both redirections apply to the whole command rather
 * than its last element, and `$?` is read *after* the group so a failing command records
 * its code instead of losing it. `printf '%s'` rather than `echo` keeps the file free of a
 * trailing newline the reader would have to strip.
 *
 * The whole of that is then handed to {@link SESSION_OPEN} as one quoted word, which is what
 * makes the wrapper a session leader rather than one more process in envd's session 511. The
 * quoting is a second layer over a string that already contains quoted words, so nothing may
 * read this line by scanning for a path any more — {@link journalledScriptIn} peels the layer
 * off first, and `wrapper-table.ts` parses what comes back.
 */
export function journalledCommand(argv: readonly string[], paths: JournalPaths): string {
  return `${SESSION_OPEN}${quoteArg(journalledScript(argv, paths))}`
}

/** The journal script itself, before {@link SESSION_OPEN} wraps it. */
function journalledScript(argv: readonly string[], paths: JournalPaths): string {
  return `${ARGV_OPEN}${quoteArgv(argv)}${ARGV_CLOSE}${quoteArg(paths.stdout, 'the stdout journal path')} 2> ${quoteArg(paths.stderr, 'the stderr journal path')}`
    + ` ; printf '%s' "$?" > ${quoteArg(paths.exit, 'the exit journal path')}`
}

/**
 * The journal script inside a wrapper's command line, whichever way it was started.
 *
 * e2b reports a command as the shell it ran plus its argv, so the line this is handed is
 * `/bin/bash -l -c setsid --wait sh -c '<script>'`. The peel is at the first occurrence of the
 * prefix **outside quoting** — not the first occurrence anywhere. Ours is emitted unquoted and
 * anything a prompt smuggles in is necessarily quoted, because `quoteArg` wraps every argv
 * element and every string containing this prefix has spaces in it.
 *
 * A *legacy* wrapper is what forces that distinction rather than merely justifying it. There
 * is no prefix of ours anywhere in one, so the first occurrence is whatever the argv happens
 * to hold — and a turn's prompt carries an issue body, so an issue about this very feature,
 * quoting `setsid --wait sh -c '…'` in a code span, was enough: `unquoteFirstArg` succeeded on
 * the fragment inside the prompt, the peel returned that fragment, and neither the journal
 * redirection nor the argv was in it any more. The wrapper then read as "not a journal
 * wrapper", which is a live turn the duplicate-turn guard cannot see and a second `claude` in
 * the same checkout — the failure PR #260 exists to prevent (codex, PR #276).
 *
 * A line with no top-level prefix is returned unchanged rather than rejected, and so is one
 * whose prefix is there but does not unquote. Wrappers started before this existed are still
 * running in sandboxes this code will connect to, and reading one as "not a journal wrapper"
 * is the same failure by the other route.
 */
export function journalledScriptIn(commandLine: string): string {
  const opened = unquotedIndexOf(commandLine, SESSION_OPEN)
  if (opened < 0) {
    return commandLine
  }
  // Unquoted by the rule `quoteArg` writes by, not by scanning to the next quote: the script
  // is full of `'`, so `quoteArg` emitted it as alternating quoted segments and `'\''`
  // escapes, and stopping at the first closing quote would truncate it to its first word.
  return unquoteFirstArg(commandLine, opened + SESSION_OPEN.length)?.value ?? commandLine
}
