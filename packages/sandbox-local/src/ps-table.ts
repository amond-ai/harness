/**
 * `ps` output → rows, kept pure so the parsing is testable without a process table.
 *
 * The columns are asked for in a fixed order with empty headers (`-o pid=,lstart=,args=`), so
 * there is no header line to skip and no locale-dependent column width to measure. `lstart` is
 * five whitespace-separated tokens on both platforms this backend supports — `Fri Sep 12
 * 21:33:01 2026` — and that count is the only thing this parser knows about it. The value is
 * never interpreted, only compared against the one recorded earlier for the same pid, which is
 * what lets a pid-reuse check work without this file having an opinion about date formats.
 */
import type { LocalProcessRow } from './local-surface'

/** `<pid> <5 lstart tokens> <the rest, verbatim>`. */
const ROW = /^\s*(\d+)\s+(\S+(?:\s+\S+){4})\s+(\S.*)$/

/** macOS `ps`'s `(<comm>)` in place of arguments it could not read — see {@link readableCommand}. */
const UNREAD_ARGS = /^\(.*\)$/

/**
 * What differs between the platforms' `ps`, decided by the caller so this file never has to
 * ask which platform it is on.
 */
export interface PsParseOptions {
  /**
   * Read a `(<comm>)` command as macOS `ps`'s stand-in for arguments it could not read. Off by
   * default: on Linux a parenthesised command is a real argv (systemd's `(sd-pam)`), and
   * reading it as unreadable would send it through pointless rereads and make a reused pid
   * answer "unknown" instead of "gone".
   */
  parenthesisedStandIn?: boolean
}

export function parsePsRow(line: string, options: PsParseOptions = {}): LocalProcessRow | undefined {
  const match = ROW.exec(line)
  if (!match) {
    return undefined
  }
  const pid = Number(match[1])
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined
  }
  return { pid, startedAt: match[2]!.replace(/\s+/g, ' '), command: options.parenthesisedStandIn ? readableCommand(match[3]!) : match[3]! }
}

/**
 * A command line, or `''` where `ps` printed its stand-in for one it could not read.
 *
 * macOS `ps` renders a process whose arguments it failed to read as `(<comm>)`, and the failure
 * is not reserved for zombies: an idle `/bin/sh -c` wrapper with a live command under it came
 * back as `(bash)` on roughly one read in a hundred (measured 2026-10-21, more often under
 * load). Taken at face value that is a stranger's command line, so recovery passes over a live
 * wrapper and liveness can call one gone. `''` is the registry's word for "unreadable", which it
 * answers with the start time rather than with a verdict.
 */
function readableCommand(command: string): string {
  return UNREAD_ARGS.test(command) ? '' : command
}

/**
 * Every row `ps` printed, with the unparseable ones dropped.
 *
 * Dropped rather than thrown on: this reads the whole machine's process table, one row of
 * which being unrecognisable is not a reason to fail a discovery call that was asking about
 * something else entirely.
 */
export function parsePsTable(output: string, options: PsParseOptions = {}): LocalProcessRow[] {
  const rows: LocalProcessRow[] = []
  for (const line of output.split('\n')) {
    const row = parsePsRow(line, options)
    if (row) {
      rows.push(row)
    }
  }
  return rows
}

/** The single `lstart` value of a `ps -p <pid> -o lstart=` read, or `undefined` when empty. */
export function parseStartedAt(output: string): string | undefined {
  const value = output.trim().replace(/\s+/g, ' ')
  return value === '' ? undefined : value
}
