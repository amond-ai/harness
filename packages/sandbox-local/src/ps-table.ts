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

export function parsePsRow(line: string): LocalProcessRow | undefined {
  const match = ROW.exec(line)
  if (!match) {
    return undefined
  }
  const pid = Number(match[1])
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return undefined
  }
  return { pid, startedAt: match[2]!.replace(/\s+/g, ' '), command: match[3]! }
}

/**
 * Every row `ps` printed, with the unparseable ones dropped.
 *
 * Dropped rather than thrown on: this reads the whole machine's process table, one row of
 * which being unrecognisable is not a reason to fail a discovery call that was asking about
 * something else entirely.
 */
export function parsePsTable(output: string): LocalProcessRow[] {
  const rows: LocalProcessRow[] = []
  for (const line of output.split('\n')) {
    const row = parsePsRow(line)
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
