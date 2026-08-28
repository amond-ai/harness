/**
 * Reading the journal back out of the sandbox filesystem.
 *
 * Split from `e2b-session.ts` for the 500-LOC limit (cubic review, PR #260), along the seam
 * that was already there: this module answers "what was written down", `wrapper-table.ts`
 * answers "what is running", and the session decides what the two together mean.
 *
 * Every read here is of a file the turn itself can write to. Nothing in this module treats
 * what it finds as authority over whether a process is alive — that judgement belongs to
 * e2b's process table, and the reasoning lives with it.
 */
import type { E2bSandboxLike } from './e2b-surface'
import type { JournalMeta, JournalPaths } from './journal'
import type { JournalSlice } from './log-replay'
import { journalPaths, parseJournalMeta } from './journal'

const META_SUFFIX = '.meta.json'

/**
 * How many bytes of an exit record are worth reading.
 *
 * `printf '%s' "$?"` writes at most three digits. The allowance is generous enough that a
 * stray newline or a shell that pads differently still parses, and small enough that a file
 * a turn inflated on purpose is dropped rather than buffered.
 */
const EXIT_RECORD_LIMIT = 32

/**
 * What a failed or partial journal read means to the caller asking for it.
 *
 * `'silence'` is the watchdog's reading — a sample that ends early simply reports less.
 * `'fail'` is `replayTurn`'s: it judges the turn from the transcript, so one truncated
 * without saying so is a verdict reached on evidence that was never all there. Only a read
 * that dies *after* the file opened is affected; see {@link createJournalIo}'s `streamFile`.
 */
export type PartialRead = 'silence' | 'fail'

export interface JournalIo {
  entries: () => Promise<{ name: string }[]>
  readListedMeta: (processId: string) => Promise<JournalMeta | undefined>
  readSliceFrom: (path: string, offset: number) => Promise<JournalSlice>
  /** Where a journal file currently ends — never a silent `0` for a read that failed. */
  readEndOffset: (path: string) => Promise<number>
  streamFile: (path: string, partial?: PartialRead) => AsyncGenerator<Uint8Array>
  readExitCode: (paths: JournalPaths) => Promise<number | undefined>
  readMeta: (processId: string) => Promise<JournalMeta | undefined>
  metaMatching: (processId: string, meta: JournalMeta | undefined) => JournalMeta | undefined
}

export function createJournalIo(sandbox: E2bSandboxLike, root: string): JournalIo {
/**
 * The journal root's entries, or `[]` only when the root definitively is not there.
 *
 * A missing root is an ordinary state — no turn has started in this sandbox yet — but it
 * is the *only* reason this may answer "nothing". `liveTurnProcess` in `run-workflow.ts`
 * uses the listing to find a turn that a replayed `start-turn` step already launched, and
 * that step is not idempotent: reporting an empty table because the e2b API blipped would
 * start a second `claude` in the same checkout (codex review, PR #260). Every other
 * failure therefore fails the step instead.
 *
 * The root's absence is established by asking `exists` rather than by inspecting the
 * error, whose shape is not part of the structural slice this backend takes from the SDK.
 * A probe that itself fails counts as "may exist", which keeps the safe direction.
 */
  async function journalEntries(): Promise<{ name: string }[]> {
    try {
      return await sandbox.files.list(root)
    }
    catch (cause) {
      if (await sandbox.files.exists(root).catch(() => true)) {
        throw cause
      }
      return []
    }
  }

  /**
   * Meta for a process the directory listing has already named.
   *
   * {@link readMeta} is lenient because "there is no such process" is an ordinary answer to
   * `getProcess`. Here it is not: `journalEntries` just reported this file, so a read that
   * fails is a failed read — and dropping the entry would hide a live turn from
   * `liveTurnProcess`, which is the same duplicate-turn hazard one level down from the one
   * `journalEntries` guards. A truncated or unparsable file still yields `undefined`,
   * because that genuinely records no process.
   *
   * Gemini's review of PR #260 raised this class against {@link readBytes} itself. It is
   * narrowed to here on purpose: the exit-file poll wants the leniency (a blip costs one
   * more poll, and a wrapper that really died is caught by the liveness probe instead), and
   * the suggested remedy — matching 'not found' in the SDK's error text — is not an
   * identity this backend can depend on.
   */
  async function readListedMeta(processId: string): Promise<JournalMeta | undefined> {
    const path = journalPaths(root, processId).meta
    try {
      return parseMetaOrWarn(processId, await sandbox.files.read(path, { format: 'bytes' }))
    }
    catch (cause) {
    // Judged the way {@link journalEntries} judges its own failure, and for the same
    // reason: a file that is *gone* between the listing and the read records no process,
    // while a read that failed for any other reason knows nothing — and reading "nothing
    // known" as "no process" is what lets a second `claude` start in a checkout that
    // already has one. A probe that itself fails counts as "may exist".
      if (await sandbox.files.exists(path).catch(() => true)) {
        throw cause
      }
      console.warn(`sandbox-e2b: journal meta '${processId}${META_SUFFIX}' vanished between listing and read`)
      return undefined
    }
  }

  function parseMetaOrWarn(processId: string, raw: Uint8Array): JournalMeta | undefined {
    const meta = parseJournalMeta(new TextDecoder().decode(raw))
    if (!meta) {
    // Dropping this silently is not neutral: `liveTurnProcess` uses `listProcesses` as its
    // duplicate-turn guard, so a corrupted entry reads as "no process for this run" and a
    // second `claude` turn starts with nothing in the transcript explaining why.
      console.warn(`sandbox-e2b: ignoring unparseable journal meta '${processId}${META_SUFFIX}'`)
    }
    return meta
  }

  /**
   * A journal file from `offset` on, without ever holding the bytes before it.
   *
   * e2b sends the file from the start whatever we ask, so the saving is memory, not
   * transfer: chunks before the cursor are counted and dropped instead of concatenated.
   * That is the half that can fail a run — the whole transcript in a 128MB isolate — while
   * the O(total) transfer that remains is tracked separately.
   *
   * A failed or partial read answers "nothing, from zero", which is what {@link readBytes}
   * already did and what `readLogSample` in the run workflow deliberately reads as silence:
   * output the orchestrator cannot observe is not liveness (AC-026).
   *
   * The returned `total` is the caller's *next cursor*, so it never drops below `offset`
   * even when the read served fewer bytes than that. `replayPositioned` encodes it directly,
   * and a cursor that moved backwards would make the next sample re-read output it has
   * already counted — reporting a wedged turn as alive on its own old bytes, and replaying a
   * large stale segment each time (codex review, PR #260).
   */
  async function readSliceFrom(path: string, offset: number): Promise<JournalSlice> {
    const chunks: Uint8Array[] = []
    let total = 0
    let kept = 0
    for await (const chunk of streamFile(path)) {
      const start = total
      total += chunk.length
      if (total <= offset) {
        continue
      }
      const piece = start >= offset ? chunk : chunk.subarray(offset - start)
      chunks.push(piece)
      kept += piece.length
    }
    const data = new Uint8Array(kept)
    let at = 0
    for (const chunk of chunks) {
      data.set(chunk, at)
      at += chunk.length
    }
    return { data, total: Math.max(total, offset) }
  }

  /**
   * Where a journal file ends, for a follower positioning itself at the live tail.
   *
   * Deliberately not `readSliceFrom(path, 0).total`: {@link streamFile} treats a file it
   * cannot open as silence, which is right for a stream the wrapper has not written to yet
   * and wrong for positioning. A transient `files.read` failure would answer `0`, the tail
   * would start at the beginning, and the next successful poll would serve the whole
   * retained transcript to a subscriber that asked for only what comes next — the exact
   * double-count `replay` exists to separate (codex review, PR #280).
   *
   * Absence is established by asking `exists`, the way `journalEntries` establishes the
   * root's, rather than by inspecting an error whose shape is not part of the structural
   * slice this backend takes from the SDK. A probe that itself fails counts as "may exist",
   * which keeps the safe direction: fail the subscription rather than silently replay.
   */
  async function readEndOffset(path: string): Promise<number> {
    let reader: ReadableStreamDefaultReader<Uint8Array>
    try {
      reader = (await sandbox.files.read(path, { format: 'stream' })).getReader()
    }
    catch (cause) {
      if (await isMissing(path)) {
        return 0
      }
      throw cause
    }
    try {
      let total = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          return total
        }
        total += value?.length ?? 0
      }
    }
    finally {
      await reader.cancel().catch(() => {})
    }
  }

  /** Whether the path is definitively not there; a probe that fails answers `false`. */
  async function isMissing(path: string): Promise<boolean> {
    try {
      return !await sandbox.files.exists(path)
    }
    catch {
      return false
    }
  }

  /**
   * A journal file's chunks, as e2b hands them over.
   *
   * `partial` decides what a read that dies *mid-file* means, because the two callers read it
   * oppositely. The watchdog samples for liveness, where an unreadable chunk is silence —
   * output the orchestrator cannot observe is not liveness (AC-026). `replayTurn` *judges the
   * turn from the transcript*, so serving it a truncated one as though it were whole records a
   * successful run as a failed one whenever the result line sat past the failed chunk — and a
   * transcript with a hole in it as complete whenever it did not (codex review, PR #260).
   *
   * A file that will not *open* is silence for both: the ordinary reason is that the wrapper
   * has not written to that stream yet, and a turn that produced no stderr must not fail its
   * own replay.
   */
  async function* streamFile(path: string, partial: PartialRead = 'silence'): AsyncGenerator<Uint8Array> {
    let reader: ReadableStreamDefaultReader<Uint8Array>
    try {
      reader = (await sandbox.files.read(path, { format: 'stream' })).getReader()
    }
    catch {
      return
    }
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done || value === undefined) {
          return
        }
        if (value.length > 0) {
          yield value
        }
      }
    }
    catch (cause) {
    // A read that dies mid-file serves what it already yielded; see above.
      if (partial === 'fail') {
        throw cause
      }
    }
    finally {
    // Cancelled, not merely unlocked. `releaseLock` frees the reader; the response body
    // behind it stays open, and a consumer that stops reading the transcript early —
    // `logs()`'s returned stream is cancellable, and its `cancel` returns this generator
    // — would strand one e2b connection per abandoned read for the rest of the session
    // (gemini review, PR #260). Cancelling a stream that already ran to completion is a
    // no-op, so this costs nothing on the normal path.
      await reader.cancel().catch(() => {})
    }
  }

  /** Absent, unreadable and empty are one case here: nothing to serve yet. */
  async function readBytes(path: string): Promise<Uint8Array | undefined> {
    try {
      return await sandbox.files.read(path, { format: 'bytes' })
    }
    catch {
      return undefined
    }
  }

  /**
   * The journalled exit code, read no further than an exit code could possibly go.
   *
   * The wrapper writes `printf '%s' "$?"` — at most three digits — but the file is the turn's
   * to write, and this is polled on every liveness probe for the whole length of a turn.
   * Downloading and decoding it whole first would let a turn make the Worker buffer an
   * arbitrarily large file, repeatedly, in a 128MB isolate (codex review, PR #260). Read as a
   * stream and abandoned past the cap, so an oversized file costs one bounded read and then
   * reads as no exit record — which is the honest answer: `printf` did not write that.
   */
  async function readExitCode(paths: JournalPaths): Promise<number | undefined> {
    const chunks: Uint8Array[] = []
    let total = 0
    try {
      // `'fail'` so a read that dies mid-file cannot be parsed as an exit code: half of
      // `137` is `1`, which is a perfectly plausible failure the turn never had. Absence
      // still arrives as no chunks — a file that will not open is silence either way.
      for await (const chunk of streamFile(paths.exit, 'fail')) {
        total += chunk.length
        if (total > EXIT_RECORD_LIMIT) {
          return undefined
        }
        chunks.push(chunk)
      }
    }
    catch {
      return undefined
    }
    if (total === 0) {
      return undefined
    }
    const raw = new Uint8Array(total)
    let at = 0
    for (const chunk of chunks) {
      raw.set(chunk, at)
      at += chunk.length
    }
    const code = Number(new TextDecoder().decode(raw).trim())
    return Number.isInteger(code) ? code : undefined
  }

  async function readMeta(processId: string): Promise<JournalMeta | undefined> {
    const raw = await readBytes(journalPaths(root, processId).meta)
    return raw ? parseMetaOrWarn(processId, raw) : undefined
  }

  /**
   * The id a meta file claims, checked against the id it was filed under.
   *
   * Same untrusted journal as everything else here: a meta that renames itself would send
   * `handleFor` to another process's paths, which is how a turn would point a caller's
   * `waitForExit` at a transcript and an exit record of its choosing.
   */
  function metaMatching(processId: string, meta: JournalMeta | undefined): JournalMeta | undefined {
    if (meta && meta.id !== processId) {
      console.warn(`sandbox-e2b: journal meta '${processId}${META_SUFFIX}' claims id '${meta.id}'`)
      return undefined
    }
    return meta
  }

  return {
    entries: journalEntries,
    readListedMeta,
    readSliceFrom,
    readEndOffset,
    streamFile,
    readExitCode,
    readMeta,
    metaMatching,
  }
}
