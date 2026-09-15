/**
 * Reading the journal back out of the sandbox filesystem.
 *
 * Split from the session along the seam that is already there: this module answers "what was
 * written down", and the session decides what it means. Every read here is of a file the turn
 * itself can write to, and nothing here treats what it finds as authority over whether a process
 * is alive — that judgement is the session's, made against the group the wrapper recorded.
 *
 * Two shapes of the Vercel API decide almost everything below. `readFileToBuffer` answers `null`
 * for a file that is not there and rejects for anything else, so absence and failure arrive
 * already separated — the probe-after-failure dance the e2b backend needs has no counterpart
 * here. And there is no directory API at all: a listing is `ls -1` run as a command, which is
 * why {@link JournalIo.entries} has to reason about exit codes rather than about a rejection.
 */
import type { JournalMeta, JournalPaths } from './journal'
import type { JournalSlice } from './log-replay'
import type { VercelSandboxLike } from './vercel-surface'
import { journalPaths, parseJournalMeta } from './journal'

const META_SUFFIX = '.meta.json'

/**
 * How many bytes of an exit record are worth keeping.
 *
 * `printf '%s' "$__e"` writes at most three digits. The allowance is generous enough that a
 * stray newline or a shell that pads differently still parses, and small enough that a file a
 * turn inflated on purpose is dropped rather than decoded and carried — this is polled on every
 * liveness probe for the whole length of a turn, in an isolate with a memory budget. The bytes
 * have already crossed the wire by the time the cap is applied, because there is no ranged read;
 * {@link JournalIo.readSliceFrom} documents the same cost and what the session does about it.
 */
const EXIT_RECORD_LIMIT = 32

export interface JournalIo {
  /** Filenames in the journal root. `[]` only when the root definitively is not there. */
  entries: () => Promise<string[]>
  readMeta: (processId: string) => Promise<JournalMeta | undefined>
  readListedMeta: (processId: string) => Promise<JournalMeta | undefined>
  metaMatching: (processId: string, meta: JournalMeta | undefined) => JournalMeta | undefined
  readSliceFrom: (path: string, offset: number) => Promise<JournalSlice>
  /** A whole journal file, or `undefined` when there is no such file. */
  readWhole: (path: string) => Promise<Uint8Array | undefined>
  readExitCode: (paths: JournalPaths) => Promise<number | undefined>
  /** A pid the wrapper journalled, or `undefined` for anything that is not one. */
  readPid: (path: string) => Promise<number | undefined>
  /** Create the journal root and confirm it is there, or throw saying it is not. */
  ensureRoot: () => Promise<void>
}

export function createJournalIo(sandbox: VercelSandboxLike, root: string): JournalIo {
  /**
   * The journal root's entries, or `[]` only when the root definitively is not there.
   *
   * A missing root is an ordinary state — no turn has started in this sandbox yet — but it is
   * the *only* reason this may answer "nothing". `liveTurnProcess` in `run-workflow.ts` uses the
   * listing to find a turn that a replayed `start-turn` step already launched, and that step is
   * not idempotent: reporting an empty listing because the API blipped would start a second
   * `claude` in the same checkout (the reasoning `sandbox-e2b`'s `journal-io.ts:52-58` carries,
   * for the same caller). Every other failure therefore fails the step instead.
   *
   * A rejection from `runCommand` is a transport failure and propagates untouched. A non-zero
   * exit is the ambiguous case — `ls` says the same "2" for a missing directory as for one it
   * could not read — so absence is established by a second command rather than by matching
   * `ls`'s message, and a probe that itself cannot answer counts as "may exist", which keeps the
   * safe direction.
   */
  async function entries(): Promise<string[]> {
    const listing = await sandbox.runCommand({ cmd: 'ls', args: ['-1', '--', root] })
    if (listing.exitCode !== 0) {
      if (await rootIsMissing()) {
        return []
      }
      throw new Error(
        `sandbox-vercel: could not list the journal root '${root}'`
        + ` (ls exited ${String(listing.exitCode)}: ${(await listing.stderr()).trim()})`,
      )
    }
    return (await listing.stdout()).split('\n').map(line => line.trim()).filter(line => line !== '')
  }

  /** Whether the root is definitively not there; a probe that cannot answer says `false`. */
  async function rootIsMissing(): Promise<boolean> {
    try {
      return (await sandbox.runCommand({ cmd: 'test', args: ['-d', root] })).exitCode !== 0
    }
    catch {
      return false
    }
  }

  /**
   * Create the journal root, and confirm it rather than assume it.
   *
   * `mkDir` on the SDK is not recursive, so the root is made with `mkdir -p` — and the reason
   * the result is then *verified* is what a missing or unwritable root does to a turn: the
   * wrapper's redirections fail inside the sandbox, the command still runs, and nothing surfaces
   * until a caller reads an empty transcript and an absent exit record some minutes later. A
   * failure here is one line; the same failure found later is a turn nobody can account for.
   */
  async function ensureRoot(): Promise<void> {
    const made = await sandbox.runCommand({ cmd: 'mkdir', args: ['-p', '--', root] })
    if (made.exitCode !== 0) {
      throw new Error(
        `sandbox-vercel: could not create the journal root '${root}'`
        + ` (mkdir exited ${String(made.exitCode)}: ${(await made.stderr()).trim()})`,
      )
    }
    const confirmed = await sandbox.runCommand({ cmd: 'test', args: ['-d', root] })
    if (confirmed.exitCode !== 0) {
      throw new Error(
        `sandbox-vercel: journal root '${root}' is not a directory after mkdir -p;`
        + ' every command would lose its output and its exit record silently',
      )
    }
  }

  /** Absent is `undefined`; every other failure is the caller's to judge, so it propagates. */
  async function readWhole(path: string): Promise<Uint8Array | undefined> {
    return await sandbox.readFileToBuffer({ path }) ?? undefined
  }

  /**
   * A journal file from `offset` on.
   *
   * The whole file crosses the wire whatever the offset: `readFile` is the SDK's only positioned
   * read and it answers a Node stream, which this package may not name. So this is honestly
   * O(total transcript) per positioned read, and the saving the e2b backend gets from dropping
   * pre-cursor chunks as they arrive is not available here either.
   *
   * That cost is paid by the *session*, not hidden here: a positioned read is only issued once a
   * `wc -c` has said the file grew past the cursor, so the ordinary watchdog sample against a
   * quiet turn transfers nothing at all and a read of this size happens only when there is
   * genuinely that much new output to serve.
   *
   * The returned `total` is the caller's *next cursor*, so it never drops below `offset` even
   * when the file is shorter than that. A cursor that moved backwards would make the next sample
   * re-read output it has already counted — reporting a wedged turn as alive on its own old
   * bytes, and replaying a large stale segment each time.
   */
  async function readSliceFrom(path: string, offset: number): Promise<JournalSlice> {
    const bytes = await readWhole(path)
    if (bytes === undefined) {
      return { data: new Uint8Array(), total: Math.max(0, offset) }
    }
    const from = Math.min(Math.max(offset, 0), bytes.length)
    return { data: bytes.subarray(from), total: Math.max(bytes.length, offset) }
  }

  /**
   * The journalled exit code, read no further than an exit code could possibly go.
   *
   * An oversized file reads as no exit record, which is the honest answer: `printf` did not write
   * that. A read that fails outright is lenient — one blip costs one more poll, and a wrapper
   * that really died is caught by the liveness probe instead — which is the leniency the e2b
   * backend keeps narrowed to this one call for the same reason.
   */
  async function readExitCode(paths: JournalPaths): Promise<number | undefined> {
    let raw: Uint8Array | undefined
    try {
      raw = await readWhole(paths.exit)
    }
    catch {
      return undefined
    }
    if (raw === undefined || raw.length === 0 || raw.length > EXIT_RECORD_LIMIT) {
      return undefined
    }
    const code = Number(new TextDecoder().decode(raw).trim())
    return Number.isInteger(code) ? code : undefined
  }

  /**
   * A pid the wrapper wrote down, or `undefined` for anything that is not one.
   *
   * The file is the turn's to write, so the value is checked rather than trusted: `1e100` is an
   * integer to JavaScript and not a pid to any kernel, and a negative or zero value would turn a
   * pid kill into a *group* kill of something nobody named. Shared with the kill path rather
   * than read twice, so `status()` and `kill()` can never disagree about which pid is this
   * process's.
   */
  async function readPid(path: string): Promise<number | undefined> {
    let raw: Uint8Array | undefined
    try {
      raw = await readWhole(path)
    }
    catch {
      return undefined
    }
    if (raw === undefined || raw.length === 0 || raw.length > EXIT_RECORD_LIMIT) {
      return undefined
    }
    const value = Number(new TextDecoder().decode(raw).trim())
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  }

  /** Absent, unreadable and unparseable are one case here: no such process. */
  async function readMeta(processId: string): Promise<JournalMeta | undefined> {
    let raw: Uint8Array | undefined
    try {
      raw = await readWhole(journalPaths(root, processId).meta)
    }
    catch {
      return undefined
    }
    return raw === undefined ? undefined : parseMetaOrWarn(processId, raw)
  }

  /**
   * Meta for a process the listing has already named.
   *
   * {@link readMeta} is lenient because "there is no such process" is an ordinary answer to
   * `getProcess`. Here it is not: {@link entries} just reported this file, so a read that fails
   * is a failed read — and dropping the entry would hide a live turn from the duplicate-turn
   * guard, which is the same hazard {@link entries} refuses one level up. A file that is *gone*
   * between the listing and the read still yields `undefined`, because that genuinely records no
   * process, and so does a truncated one.
   */
  async function readListedMeta(processId: string): Promise<JournalMeta | undefined> {
    const raw = await readWhole(journalPaths(root, processId).meta)
    if (raw === undefined) {
      console.warn(`sandbox-vercel: journal meta '${processId}${META_SUFFIX}' vanished between listing and read`)
      return undefined
    }
    return parseMetaOrWarn(processId, raw)
  }

  function parseMetaOrWarn(processId: string, raw: Uint8Array): JournalMeta | undefined {
    const meta = parseJournalMeta(new TextDecoder().decode(raw))
    if (!meta) {
      // Dropping this silently is not neutral: a listing is the duplicate-turn guard, so a
      // corrupted entry reads as "no process for this run" and a second `claude` turn starts
      // with nothing in the transcript explaining why.
      console.warn(`sandbox-vercel: ignoring unparseable journal meta '${processId}${META_SUFFIX}'`)
    }
    return meta
  }

  /**
   * The id a meta file claims, checked against the id it was filed under.
   *
   * Same untrusted journal as everything else here: a meta that renames itself would send a
   * handle to another process's paths, which is how a turn would point a caller's `waitForExit`
   * at a transcript and an exit record of its choosing.
   */
  function metaMatching(processId: string, meta: JournalMeta | undefined): JournalMeta | undefined {
    if (meta && meta.id !== processId) {
      console.warn(`sandbox-vercel: journal meta '${processId}${META_SUFFIX}' claims id '${meta.id}'`)
      return undefined
    }
    return meta
  }

  return {
    entries,
    readMeta,
    readListedMeta,
    metaMatching,
    readSliceFrom,
    readWhole,
    readExitCode,
    readPid,
    ensureRoot,
  }
}
