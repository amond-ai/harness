/**
 * Journal state, written into the fake sandbox of `vercel-sandbox.fake.ts`.
 *
 * The other half of that file's cut: the fake models what a Vercel sandbox *is* — its process
 * table, its files, its `runCommand` dispatch — and this models what a turn *did* inside one. A
 * suite reaches for both, and neither grows into the other.
 *
 * Nothing here simulates a shell either. `startProcess` writes the pid records the wrapper of
 * `journal.ts` would have written and puts its process group in the table; `endProcess` empties
 * that group and publishes `$?`. The distinction the whole backend turns on — a turn can write
 * the journal, it cannot write the process table — is exactly what {@link forgeExit} and
 * {@link killWrapperOnly} exist to produce.
 */
import type { ProcessLogEvent } from '@amond-ai/sandbox'
import type { JournalMeta } from './journal'
import type { Fake } from './vercel-sandbox.fake'
import { journalPaths, serializeJournalMeta, wrapperMarker } from './journal'
import { AT, decode, encode, ROOT } from './vercel-sandbox.fake'

/** The wrapper's own pid, which is also its process-group id under `setsid`. */
export interface FakeStart {
  pid?: number
  /** The pid `$!` recorded for the wrapped command — a member of the group, not its leader. */
  childPid?: number
}

/**
 * Put a started wrapper into the fake: its process group, its pid records, its empty journal.
 *
 * The command line is built from {@link wrapperMarker}, which is the single source the probe
 * script anchors on too — so a test cannot pass by agreeing with a marker the real script does
 * not write.
 *
 * The meta is written only when there is not one already. An `exec` has just written its own,
 * with the `cmdId` and `sessionId` the warm path matches against, and a fixture that overwrote
 * them would quietly disable the very path the test is exercising.
 */
export function startProcess(fake: Fake, id: string, start: FakeStart = {}): JournalMeta {
  const paths = journalPaths(ROOT, id)
  const pid = start.pid ?? 4000
  const child = start.childPid ?? pid + 1
  fake.procs.set(pid, { cmdline: `${wrapperMarker(id)}printf '%s' "$$"`, pgid: pid })
  fake.procs.set(child, { cmdline: 'claude --print', pgid: pid })
  fake.files.set(paths.pgid, encode(String(pid)))
  fake.files.set(paths.pid, encode(String(child)))
  fake.files.set(paths.out, encode(''))
  fake.files.set(paths.err, encode(''))
  const existing = fake.files.get(paths.meta)
  const meta: JournalMeta = {
    id,
    cmdId: 'cmd_1',
    sessionId: fake.session ?? '',
    command: ['claude', '--print'],
    cwd: '/vercel/sandbox',
    startedAt: AT,
  }
  if (existing === undefined) {
    fake.files.set(paths.meta, encode(serializeJournalMeta(meta)))
    return meta
  }
  return JSON.parse(decode(existing)) as JournalMeta
}

function append(fake: Fake, path: string, text: string): void {
  const before = fake.files.get(path) ?? new Uint8Array()
  const added = encode(text)
  const grown = new Uint8Array(before.length + added.length)
  grown.set(before)
  grown.set(added, before.length)
  fake.files.set(path, grown)
}

/** Bytes the process wrote to its stdout journal. */
export function writeOut(fake: Fake, id: string, text: string): void {
  append(fake, journalPaths(ROOT, id).out, text)
}

/** Bytes the process wrote to its stderr journal. */
export function writeErr(fake: Fake, id: string, text: string): void {
  append(fake, journalPaths(ROOT, id).err, text)
}

/**
 * The ordinary ending: the group empties and `$?` is published.
 *
 * `corroborated` is the second half of that ending, and it is off by default because the default
 * is the *cold* case — a sandbox resumed into a new session, which is what a retried workflow
 * step reattaches to, can resolve no command id at all and has only the journal file.
 */
export function endProcess(fake: Fake, id: string, code: number, corroborated = false): void {
  const paths = journalPaths(ROOT, id)
  const group = Number(decode(fake.files.get(paths.pgid) ?? new Uint8Array()).trim())
  for (const [pid, proc] of [...fake.procs]) {
    if (proc.pgid === group) {
      fake.procs.delete(pid)
    }
  }
  fake.files.set(paths.exit, encode(String(code)))
  if (corroborated) {
    const meta = JSON.parse(decode(fake.files.get(paths.meta) ?? encode('{}'))) as Partial<JournalMeta>
    const command = fake.commands.get(meta.cmdId ?? '')
    if (command) {
      // The fake's handles are plain objects; the interface calls `exitCode` readonly because
      // nothing in `src/` may write it, not because Vercel never does.
      ;(command as { exitCode: number | null }).exitCode = code
    }
  }
}

/**
 * The SIGKILLed wrapper: its group is gone and it published nothing.
 *
 * The case `no_exit_record` exists for, and the one a poller alone can never distinguish from a
 * slow turn — the wrapper's `printf '%s' "$?"` runs *after* the command, so a wrapper killed
 * outright never writes one at all.
 */
export function killWrapperOnly(fake: Fake, id: string): void {
  const paths = journalPaths(ROOT, id)
  const group = Number(decode(fake.files.get(paths.pgid) ?? new Uint8Array()).trim())
  for (const [pid, proc] of [...fake.procs]) {
    if (proc.pgid === group) {
      fake.procs.delete(pid)
    }
  }
}

/**
 * An exit record written while the group is still alive — what a prompt-injected or merely buggy
 * turn can do, since the journal lives in a filesystem it can write to.
 *
 * Nothing may settle on this alone. It is the fixture behind the duplicate-turn hazard: a wait
 * that resolved here would report the attempt finished, free the checkout for a retry, and let a
 * second `claude` start beside the first.
 */
export function forgeExit(fake: Fake, id: string, code: number): void {
  fake.files.set(journalPaths(ROOT, id).exit, encode(String(code)))
}

/**
 * A monotonic clock that jumps `stepMs` every time it is read.
 *
 * Injected as `monotonicNowMs` so a wait's deadline — and the absence of one — can be reached in
 * a handful of polls rather than in wall-clock time.
 */
export function leapingClock(stepMs: number): () => number {
  let at = 0
  return () => {
    const reading = at
    at += stepMs
    return reading
  }
}

/** Everything a `logs()` stream yields, drained to completion. */
export async function streamOf(stream: ReadableStream<ProcessLogEvent>): Promise<ProcessLogEvent[]> {
  const events: ProcessLogEvent[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) {
      return events
    }
    events.push(value)
  }
}
