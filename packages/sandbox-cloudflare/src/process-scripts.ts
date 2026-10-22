/**
 * Background processes, from "Run background processes"
 * (https://developers.cloudflare.com/sandbox/commands/run-background-processes/): one directory
 * per process under {@link PROCESS_ROOT}, holding `pid`, `stdout.log`, `stderr.log`, `meta.json`
 * and `exit-code`.
 *
 * The command runs under `setsid` in the foreground of {@link RUN}, not with `&`: a shell starts
 * a background job with SIGINT ignored.
 */
import type { ProcessMeta, ProcessState } from './rpc'
import { isProcessId } from '@amond-ai/sandbox/journal'

export { isProcessId }

export const PROCESS_ROOT = '/var/lib/processes'

const TIMEOUT_GRACE_SECONDS = 5

/** `$1` is the root, `$2` the process directory, `$3` the meta JSON. Fails if the id is taken. */
export const PREPARE = `root=$1; dir=$2
mkdir -p "$root" && mkdir "$dir" && printf '%s' "$3" >"$dir/meta.json"`

/** `$1` is the directory, `$2` the timeout in seconds or empty, and the rest is the argv. */
export const RUN = `dir=$1; seconds=$2; shift 2
if [ -n "$seconds" ]; then
  (
    sleep "$seconds"
    [ -e "$dir/exit-code" ] && exit 0
    read -r pid boot <"$dir/pid" || exit 0
    : >"$dir/timed-out"
    kill -s TERM -- "-$pid"
    sleep ${TIMEOUT_GRACE_SECONDS}
    [ -e "$dir/exit-code" ] || kill -s KILL -- "-$pid"
  ) >/dev/null 2>&1 &
fi
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' \\
  "$dir" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
echo "$?" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`

const CURRENT = `current() {
  read -r pid boot 2>/dev/null <"$1/pid" &&
    [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ]
}`

/** STATUS, then the timeout marker, then `meta.json` — three lines per process. */
const REPORT = `${CURRENT}
code() { head -c 16 "$1/exit-code" | tr -d '\\n'; }
report() {
  dir=$1
  if [ ! -d "$dir" ]; then echo missing
  elif [ -e "$dir/exit-code" ]; then echo "exited $(code "$dir")"
  elif [ ! -e "$dir/pid" ]; then echo starting
  elif current "$dir" && kill -0 "$pid" 2>/dev/null; then echo "running $pid"
  elif [ -e "$dir/exit-code" ]; then echo "exited $(code "$dir")"
  else echo lost
  fi
  if [ -e "$dir/timed-out" ]; then echo timed-out; else echo; fi
  printf '%s\\n' "$(head -c 65536 "$dir/meta.json" 2>/dev/null | tr -d '\\n')"
}`

/** `$1` is the process directory. */
export const STATUS = `${REPORT}
report "$1"`

/** `$1` is {@link PROCESS_ROOT}. Each process prints its id, then its three report lines. */
export const LIST = `${REPORT}
for entry in "$1"/*/; do
  [ -d "$entry" ] || continue
  entry=\${entry%/}
  echo "\${entry##*/}"
  report "$entry"
done`

/** `$1` is the file, `$2` the byte offset, `$3` the most bytes to return. Silent when absent. */
export const READ_SLICE = `[ -e "$1" ] || exit 0
dd status=none if="$1" iflag=skip_bytes,count_bytes bs=65536 skip="$2" count="$3"`

/** `$1` is the file. */
export const SIZE = `if [ -e "$1" ]; then wc -c <"$1"; else echo 0; fi`

/** Exit status of {@link KILL} when there is no pid this instance of the container wrote. */
export const KILL_NO_PID = 3
/** Exit status of {@link KILL} when the process has already recorded its exit. */
export const KILL_EXITED = 4

/** `$1` is the process directory, `$2` the signal name. */
export const KILL = `${CURRENT}
dir=$1
[ -e "$dir/exit-code" ] && exit ${KILL_EXITED}
current "$dir" || exit ${KILL_NO_PID}
kill -s "$2" -- "-$pid"`

/** Linux signal numbers to the names `kill -s` takes. */
const SIGNAL_NAMES: Readonly<Record<number, string>> = {
  1: 'HUP',
  2: 'INT',
  3: 'QUIT',
  4: 'ILL',
  5: 'TRAP',
  6: 'ABRT',
  7: 'BUS',
  8: 'FPE',
  9: 'KILL',
  10: 'USR1',
  11: 'SEGV',
  12: 'USR2',
  13: 'PIPE',
  14: 'ALRM',
  15: 'TERM',
  17: 'CHLD',
  18: 'CONT',
  19: 'STOP',
  20: 'TSTP',
  21: 'TTIN',
  22: 'TTOU',
  23: 'URG',
  24: 'XCPU',
  25: 'XFSZ',
  26: 'VTALRM',
  27: 'PROF',
  28: 'WINCH',
  29: 'IO',
  30: 'PWR',
  31: 'SYS',
}

export function signalName(signal: number): string | undefined {
  return SIGNAL_NAMES[signal]
}

export function processDir(id: string): string {
  if (!isProcessId(id)) {
    throw new Error(`invalid process id '${id}': expected [A-Za-z0-9_-]+`)
  }
  return `${PROCESS_ROOT}/${id}`
}

/** The STATUS line and the marker line back into a state; `undefined` for `missing`. */
export function parseState(statusLine: string, markerLine: string): ProcessState | undefined {
  const [word, value] = statusLine.trim().split(' ')
  if (word === 'running') {
    const pid = Number(value)
    return Number.isSafeInteger(pid) && pid > 0 ? { state: 'running', pid } : { state: 'lost' }
  }
  if (word === 'exited') {
    const code = Number(value)
    return value !== undefined && /^\d+$/.test(value) && Number.isSafeInteger(code)
      ? { state: 'exited', code, timedOut: markerLine.trim() === 'timed-out' }
      : { state: 'lost' }
  }
  if (word === 'starting' || word === 'lost') {
    return { state: word }
  }
  return undefined
}

/** `meta.json` back into a record, or `undefined` for anything that is not one. */
export function parseMeta(text: string, id: string): ProcessMeta | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch {
    return undefined
  }
  const meta = parsed as Partial<ProcessMeta> | null
  if (meta?.id !== id || !Array.isArray(meta.command) || meta.command.length === 0
    || !meta.command.every(part => typeof part === 'string')
    || (meta.cwd !== undefined && typeof meta.cwd !== 'string')
    || typeof meta.startedAt !== 'string') {
    return undefined
  }
  return { id, command: meta.command, cwd: meta.cwd, startedAt: meta.startedAt }
}
