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

/**
 * `start_of PID` prints the process's start time (field 22 of `/proc/PID/stat`, read past the
 * parenthesised name, whose own spaces would shift the fields). `alive PID` succeeds while the
 * process exists and is not a zombie, and `group_alive PGID` while the group has such a member:
 * PID 1 in a sandbox image is often `sleep`, which reaps nothing, so a `kill -0` would count the
 * dead forever.
 */
const PROC = `start_of() {
  read -r line 2>/dev/null <"/proc/$1/stat" || return 1
  set -- \${line##*) }
  shift 19
  echo "$1"
}
alive() {
  read -r line 2>/dev/null <"/proc/$1/stat" || return 1
  set -- \${line##*) }
  [ "$1" != Z ]
}
group_alive() {
  g=$1
  for s in /proc/[0-9]*/stat; do
    read -r line 2>/dev/null <"$s" || continue
    set -- \${line##*) }
    [ "$3" = "$g" ] && [ "$1" != Z ] && return 0
  done
  return 1
}`

/**
 * Whether the record in file `$1` — `pid` or `supervisor` — names a process this container
 * started, leaving its fields in `$pid`, `$boot` and `$start`. The start time catches a pid
 * reused within one boot. A leader that has exited — even between two reads here — has no `/proc`
 * entry to compare, and its pid cannot be reused while its group still holds it as a pgid. A
 * two-field `pid` file from before the start time was recorded is checked by boot id alone.
 *
 * `supervised DIR` succeeds while the RUN that owns DIR is still alive, without touching `$pid`.
 */
const CURRENT = `${PROC}
current() {
  read -r pid boot start 2>/dev/null <"$1" &&
    [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] &&
    { [ -z "$start" ] || { now=$(start_of "$pid"); [ -z "$now" ] || [ "$now" = "$start" ]; }; }
}
supervised() { ( current "$1/supervisor" && alive "$pid" ); }`

/**
 * `$1` is the directory, `$2` the timeout in seconds or empty, and the rest is the argv. The
 * caller's env arrives in the environment, never in argv, where `ps` would show it. The supervisor
 * runs on a fixed `PATH` so a caller's `PATH` cannot hide `setsid`, `sleep` or `mv` from it; the
 * inherited one is restored just before the command is `exec`ed.
 *
 * The exit is published once the whole group is gone, not when its leader exits: ProcessStatus
 * describes the supervised group, so a command that detached a child is `running` — and
 * reachable by KILL — until that child ends too. The status recorded is still the leader's.
 *
 * The supervisor records itself in `supervisor` first, so STATUS can tell a group that is gone
 * while its exit is still being published (`running`) from one whose supervisor died (`lost`).
 *
 * The watchdog waits for the pid file however short the timeout, then decides on the group's
 * liveness alone — never on `exit-code`, which the command can write — so a command that ended
 * at the deadline is not marked `timed-out`, and one that forged its exit still is. While it waits
 * for the pid file, an `exit-code` can only be the supervisor's: the command starts after it.
 */
export const RUN = `${PROC}
dir=$1; seconds=$2; shift 2
cmd_path=\${PATH-}
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin; export PATH
echo "$$ $(cat /proc/sys/kernel/random/boot_id) $(cut -d" " -f22 /proc/$$/stat)" >"$dir/supervisor.tmp"
mv "$dir/supervisor.tmp" "$dir/supervisor"
if [ -n "$seconds" ]; then
  (
    sleep "$seconds"
    until read -r pid boot start 2>/dev/null <"$dir/pid"; do
      [ -e "$dir/exit-code" ] && exit 0
      sleep 0.1
    done
    group_alive "$pid" || exit 0
    : >"$dir/timed-out"
    kill -s TERM -- "-$pid"
    sleep ${TIMEOUT_GRACE_SECONDS}
    group_alive "$pid" && kill -s KILL -- "-$pid"
  ) >/dev/null 2>&1 &
fi
setsid sh -c 'd=$0; p=$1; shift
echo "$$ $(cat /proc/sys/kernel/random/boot_id) $(cut -d" " -f22 /proc/$$/stat)" >"$d/pid.tmp"
mv "$d/pid.tmp" "$d/pid"
PATH=$p; export PATH
exec "$@"' "$dir" "$cmd_path" "$@" >"$dir/stdout.log" 2>"$dir/stderr.log"
status=$?
if read -r pid boot start 2>/dev/null <"$dir/pid"; then
  while group_alive "$pid"; do sleep 0.2; done
fi
echo "$status" >"$dir/exit-code.tmp" && mv "$dir/exit-code.tmp" "$dir/exit-code"`

/**
 * STATUS, then the timeout marker, then `meta.json` — three lines per process.
 *
 * An `exit-code` is believed only once the recorded group and its supervisor are gone: the
 * command runs as the same user and can write that file itself, but it cannot fake their
 * liveness. While the supervisor lives, the group has drained but the exit is not published yet
 * (or was just published), so the process still reads `running` rather than `lost`.
 */
const REPORT = `${CURRENT}
code() { head -c 16 "$1/exit-code" | tr -d '\\n'; }
report() {
  dir=$1
  if [ ! -d "$dir" ]; then echo missing
  elif current "$dir/pid" && { alive "$pid" || group_alive "$pid" || supervised "$dir"; }; then echo "running $pid"
  elif [ -e "$dir/exit-code" ]; then echo "exited $(code "$dir")"
  elif [ ! -e "$dir/pid" ]; then echo starting
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

/**
 * Exit status of {@link KILL} when there is no live group this instance of the container
 * started, nor a supervisor still publishing its exit: no pid, a stale one, or a `lost` process.
 */
export const KILL_NO_PID = 3
/** Exit status of {@link KILL} when the group is gone and its exit is recorded or being published. */
export const KILL_EXITED = 4

/**
 * `$1` is the process directory, `$2` the signal name. A live group is signalled whatever
 * `exit-code` says, since the command can write that file itself; see {@link STATUS}. A group that
 * is gone while its supervisor publishes the exit has nothing left to signal: {@link KILL_EXITED}.
 */
export const KILL = `${CURRENT}
dir=$1
if current "$dir/pid" && group_alive "$pid"; then kill -s "$2" -- "-$pid"; exit; fi
[ -e "$dir/exit-code" ] && exit ${KILL_EXITED}
supervised "$dir" && exit ${KILL_EXITED}
exit ${KILL_NO_PID}`

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
