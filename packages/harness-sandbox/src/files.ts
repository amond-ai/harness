/**
 * The harness's file surface over {@link SandboxSession}'s.
 *
 * Three differences have to be reconciled, and each one is a decision rather than a rename:
 *
 * - **Absence.** The contract's `readFile` rejects when the path is not there; the harness's
 *   reads answer `null`. The contract's own note names the fix — "callers wanting
 *   absence-as-value pair it with `exists`" — so every read here is an `exists` followed by a
 *   read. It costs a round trip and buys the harness's documented shape. The two calls can
 *   also disagree, and {@link readingAbsence} is where that is handled.
 * - **Parent directories.** The harness says of all three writes that they create parent
 *   directories recursively. The contract's `writeFile` promises nothing of the kind, and
 *   whether a given backend's does is not something this package can establish for backends
 *   it has never run against. So the `mkdir` is unconditional; a redundant recursive `mkdir`
 *   costs one call, a missing one loses the write.
 * - **Encodings.** The contract's write takes `string | ReadableStream<Uint8Array>` and names
 *   only UTF-8 and base64, so bytes go out as base64 and a text encoding the platform cannot
 *   produce is refused rather than silently written as UTF-8. Reads have no such limit —
 *   they decode the raw bytes with `TextDecoder`, which handles every label the harness's
 *   `encoding` option might name.
 *
 * `abortSignal` is honoured, and what it can promise differs between the two halves:
 *
 * - **A read never outlives the signal.** Every awaited sandbox call is bracketed by a
 *   `throwIfAborted()` — before it, so none is started after the caller has cancelled, and
 *   after it, before anything is decided from what it answered. The second half is what makes
 *   the claim true of *absence* as well: a read that leaves through `return null` has decided
 *   something on the caller's behalf, and "it is not there" told to a caller that cancelled
 *   is a wrong instruction rather than a stale value. The drain, the one part with no natural
 *   end, is cancellable from the inside, so a read already running is stopped rather than
 *   waited out; and whichever way an aborted read ends — refused, cancelled, or failed by the
 *   backend as it went — the caller is handed its own reason. Nothing about a read has to be
 *   finished once it is unwanted: reading mutates nothing, so abandoning one leaves the
 *   sandbox exactly as it was.
 * - **A write already in flight is left to finish**, and that is the whole of the exclusion.
 *   The contract's `writeFile` takes no signal — only `logs()` and `waitForExit()` do — so
 *   there is nothing to forward one to, and tearing the call off part-way is what would leave
 *   a half-written file behind. That argument is about *mutation*, which is exactly why it
 *   stops at the writes and does not reach the reads. For the same reason there is no check
 *   after the final write: the mutation has landed, and reporting a cancellation for it would
 *   describe a sandbox that does not exist.
 *
 * `throwIfAborted()` throws `signal.reason`, the same value `process.ts` throws for the same
 * situation one call earlier, so a caller sees one rejection value however the abort was timed.
 *
 * One read is deliberately not symmetrical with the other two, and the difference is who owns
 * the pull loop. `readBinaryFile` and `readTextFile` drain the stream themselves, so an
 * aborted caller has no handle to stop them with and {@link bytesOf}
 * refuses on its behalf. `readFile` hands the stream back having pulled nothing: the caller
 * holds both it and the signal it aborted, and returning a handle starts no operation. So an
 * abort landing during a streaming read still yields the stream, live and uncancelled, for
 * the caller to drain or release as it chooses.
 */
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import type { SandboxSession } from '@pleaseai/sandbox-contract'
import { bestEffort } from './best-effort'

/** The file half of the harness session — everything below `run`/`spawn`. */
export type HarnessFileSurface = Pick<
  HarnessV1NetworkSandboxSession,
  'readFile' | 'readBinaryFile' | 'readTextFile' | 'writeFile' | 'writeBinaryFile' | 'writeTextFile'
>

/** The two halves {@link createFileSurface} joins, named so each factory can state its own. */
type HarnessReadSurface = Pick<HarnessFileSurface, 'readFile' | 'readBinaryFile' | 'readTextFile'>
type HarnessWriteSurface = Pick<HarnessFileSurface, 'writeFile' | 'writeBinaryFile' | 'writeTextFile'>

/**
 * How many bytes are turned into characters per `String.fromCharCode` call.
 *
 * The spread form applies the whole array as arguments, and a large array overflows the
 * argument stack — measured under Bun 1.3.14, `String.fromCharCode(...new Uint8Array(n))`
 * survives `n = 500_000` and throws `RangeError` at `n = 1_000_000`. 32 KiB is comfortably
 * under that on every engine and keeps the loop short for the file sizes an agent writes.
 */
const BASE64_CHUNK = 0x8000

export function createFileSurface(sandbox: SandboxSession): HarnessFileSurface {
  return { ...createReadSurface(sandbox), ...createWriteSurface(sandbox) }
}

/**
 * The reads: a cluster over one idea, which is a read whose absence is a value rather than a
 * rejection and which never outlives its caller's signal. `present`, `readingAbsence`,
 * `streamOf` and `bytesOf` below are the steps of it, and each takes its `sandbox` explicitly
 * — they were closures over one until the enclosing factory outgrew the 50-line limit, and an
 * explicit parameter is what a reader can follow without holding the enclosing scope in mind.
 */
function createReadSurface(sandbox: SandboxSession): HarnessReadSurface {
  return {
    readFile: ({ path, abortSignal }) => streamOf(sandbox, path, abortSignal),
    readBinaryFile: ({ path, abortSignal }) => bytesOf(sandbox, path, abortSignal),
    readTextFile: async ({ path, encoding, startLine, endLine, abortSignal }) => {
      const bytes = await bytesOf(sandbox, path, abortSignal)
      if (bytes === null) {
        return null
      }
      return sliceLines(new TextDecoder(encoding ?? 'utf-8').decode(bytes), startLine, endLine)
    },
  }
}

async function present(sandbox: SandboxSession, path: string): Promise<boolean> {
  return (await sandbox.exists(path)).exists
}

/**
 * A read whose "not found" is the harness's `null` rather than a rejection.
 *
 * The `exists` above is not enough on its own. The two calls are a round trip apart, and the
 * sandbox is a live machine with the agent's own turn running in it: a path that existed for
 * `exists` can be gone before `readFile` asks for it — a checkout, a build that cleans its
 * output, the turn deleting a file it had just listed. Letting that rejection through would
 * hand the agent a failed tool call for what the harness documents as an ordinary `null`.
 *
 * The re-probe is how a not-found is told apart from a real failure, and it is the only way
 * available: `SandboxFiles.readFile` promises just "rejects when the path does not exist" —
 * no error type, code or message a backend must use — so every backend rejects with whatever
 * its own transport threw, and matching on that would be a guess. Asking the sandbox again is
 * a fact about the sandbox. A re-probe that *itself* fails counts as "may exist" and the
 * original error is rethrown, which keeps the safe direction: a swallowed transport failure
 * would report an unreachable sandbox as an empty workspace, and the agent would act on it.
 * The extra call is only ever paid on the failing path.
 */
async function readingAbsence<T>(
  sandbox: SandboxSession,
  path: string,
  abortSignal: AbortSignal | undefined,
  read: () => Promise<T>,
): Promise<T | null> {
  try {
    return await read()
  }
  catch (cause) {
    // The re-probe is a sandbox call like any other, so a caller that cancelled while the
    // read was in flight does not get one issued on its behalf — and it is handed its own
    // reason rather than whatever the cancelled read happened to throw, which is the
    // distinction `process.ts` restores for the same reason.
    abortSignal?.throwIfAborted()
    const mayExist = await present(sandbox, path).catch(() => true)
    // And again on the far side of the re-probe, for the reason `streamOf` gives: both arms
    // leave through an answer the caller acts on, and the `null` one is the arm that turns
    // a cancellation into "carry on, it is not there".
    abortSignal?.throwIfAborted()
    if (mayExist) {
      throw cause
    }
    return null
  }
}

/** The byte stream of a path's contents, or `null` when the path is not there. */
async function streamOf(
  sandbox: SandboxSession,
  path: string,
  abortSignal: AbortSignal | undefined,
): Promise<ReadableStream<Uint8Array> | null> {
  abortSignal?.throwIfAborted()
  const exists = await present(sandbox, path)
  // The probe's answer is held and the check hoisted above the branch, rather than repeated
  // inside each arm. The rule is then one a reader can apply by looking at the `await`s
  // alone — *every* awaited call is followed by a check before anything is decided from its
  // result — instead of one that has to be re-verified against every `return` in the
  // function, and a branch added later inherits it. The absent arm needs it every bit as
  // much as the present one: `null` is not a milder answer than an error here, it is a
  // different instruction, and a caller told "not there" after it cancelled proceeds as if
  // the file were genuinely missing (codex review, PR #272).
  abortSignal?.throwIfAborted()
  if (!exists) {
    return null
  }
  return readingAbsence(sandbox, path, abortSignal, async () => (await sandbox.readFile(path, { encoding: 'none' })).content)
}

/**
 * The raw bytes, or `null` when the path is not there.
 *
 * The drain is a sandbox operation in its own right rather than the tail of the read before
 * it — the stream resolves before a single byte has moved — so the whole abort contract for
 * it lives in {@link collect}, which owns the reader and is the only thing able to stop a
 * pull once one is outstanding.
 */
async function bytesOf(
  sandbox: SandboxSession,
  path: string,
  abortSignal: AbortSignal | undefined,
): Promise<Uint8Array | null> {
  const content = await streamOf(sandbox, path, abortSignal)
  return content === null ? null : collect(content, abortSignal)
}

/**
 * The `mkdir` every write is preceded by, and both of the write's abort guards.
 *
 * The second one is why they live here rather than at the three call sites: the `mkdir` is
 * an `await` to a live machine, and the line after this call is the write itself — the last
 * point at which refusing still leaves the file untouched.
 */
async function intoDirectoryFor(
  sandbox: SandboxSession,
  path: string,
  abortSignal: AbortSignal | undefined,
): Promise<void> {
  abortSignal?.throwIfAborted()
  const parent = parentDirectory(path)
  if (parent !== undefined) {
    await sandbox.mkdir(parent, { recursive: true })
  }
  abortSignal?.throwIfAborted()
}

/**
 * The writes: create the parent, then write, refusing before the mutation either way.
 *
 * The encoding refusal sits in `writeTextFile` rather than in {@link intoDirectoryFor}
 * because it is a decision about the payload, not about the path, and it has to happen
 * before the `mkdir` — a directory created for a write that was never going to be allowed
 * is a side effect on a rejected call.
 */
function createWriteSurface(sandbox: SandboxSession): HarnessWriteSurface {
  return {
    writeFile: async ({ path, content, abortSignal }) => {
      await intoDirectoryFor(sandbox, path, abortSignal)
      await sandbox.writeFile(path, content)
    },
    writeBinaryFile: async ({ path, content, abortSignal }) => {
      await intoDirectoryFor(sandbox, path, abortSignal)
      await sandbox.writeFile(path, toBase64(content), { encoding: 'base64' })
    },
    writeTextFile: async ({ path, content, encoding, abortSignal }) => {
      if (encoding !== undefined && encoding !== 'utf-8' && encoding !== 'utf8') {
        throw new Error(
          `cannot write '${path}' as '${encoding}': the sandbox contract encodes text as UTF-8 only`,
        )
      }
      await intoDirectoryFor(sandbox, path, abortSignal)
      await sandbox.writeFile(path, content, { encoding: 'utf-8' })
    },
  }
}

/**
 * The directory a path lives in, or `undefined` when the path names no directory at all.
 *
 * POSIX-only by construction: sandbox paths are container paths, and the contract's callers
 * spell them with forward slashes whatever host the orchestrator runs on.
 */
export function parentDirectory(path: string): string | undefined {
  const cut = path.lastIndexOf('/')
  if (cut < 0) {
    return undefined
  }
  return cut === 0 ? '/' : path.slice(0, cut)
}

/**
 * A 1-based, inclusive line range, as the harness documents it.
 *
 * A range that names neither end returns the text untouched rather than round-tripping it
 * through `split`/`join`. `startLine` below 1 is out of contract and clamped to the first
 * line: passed on as a negative index it would mean *the last* lines, which is the one
 * wrong answer that still looks like a successful read.
 */
export function sliceLines(text: string, startLine?: number, endLine?: number): string {
  if (startLine === undefined && endLine === undefined) {
    return text
  }
  const lines = text.split('\n')
  const from = Math.max(0, (startLine ?? 1) - 1)
  return lines.slice(from, endLine ?? lines.length).join('\n')
}

/**
 * Concatenate a byte stream into one array, abandoning it if the caller aborts.
 *
 * Written over a reader rather than `new Response(stream).arrayBuffer()`, and that is the
 * whole point of the function. A drain in progress *locks* its stream, so the obvious
 * cancellation — reaching for `stream.cancel()` from an abort listener — throws
 * `TypeError: Invalid state: ReadableStream is locked` and leaves the outstanding `read()`
 * pending for ever; a best-effort wrapper then swallows the `TypeError` and the caller hangs
 * silently. Cancelling through the reader is the spelling that works: the pending `read()`
 * resolves `{ done: true }`, this loop falls out, and the reason is thrown (all measured
 * under Bun 1.3.14).
 *
 * Three things are needed and each covers a distinct failure:
 *
 * - the **pre-check**, because a listener attached to an already-aborted signal never fires —
 *   `abort` is one-shot, the same DOM behaviour `process.ts` guards for twice — so a caller
 *   that aborted before the drain began would otherwise be served a full read;
 * - the **listener**, because an abort landing after that check has nothing else to stop a
 *   pull that is already outstanding, which is the difference between a slow read and one
 *   that never settles;
 * - the **post-loop check**, because a cancelled drain ends the way a complete one does. Two
 *   lines of a file the caller stopped wanting, returned as if they were the file, is the
 *   worst of the three outcomes: it is not an error the caller can see.
 *
 * The cancels are best-effort so a stream that fails to release cannot replace the caller's
 * own abort reason with a teardown error — the reason `bestEffort` exists. They are also
 * started rather than waited on, which is why the pre-check calls the listener's own
 * `release` instead of awaiting a cancel of its own: `cancel()` runs the backend's teardown,
 * and a backend that hangs there would hold the rejection back for exactly as long as it
 * hung. That is this function's own bug — a read outliving the signal that cancelled it —
 * reintroduced in the line that refuses the read. Nothing waits on the outcome either way,
 * since `bestEffort` discards it, so awaiting bought only the delay (codex review, PR #272).
 */
async function collect(
  stream: ReadableStream<Uint8Array>,
  abortSignal: AbortSignal | undefined,
): Promise<Uint8Array> {
  const reader = stream.getReader()
  const release = (): void => void bestEffort(() => reader.cancel(abortSignal?.reason))
  if (abortSignal?.aborted === true) {
    release()
    throw abortSignal.reason
  }
  abortSignal?.addEventListener('abort', release, { once: true })
  try {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      chunks.push(value)
      total += value.length
    }
    abortSignal?.throwIfAborted()
    return concat(chunks, total)
  }
  catch (cause) {
    // A `read()` can reject on its own — a transport reset part-way through the drain — and
    // that rejection leaves before the check above ever runs. Restoring the reason is what
    // `readingAbsence` and `process.ts` already do at every other abort site, and the value
    // is the whole point: it is what a caller matches on to recognise its own cancellation,
    // so one path answering with the backend's error instead makes the surface unreadable.
    // Unaborted, the cause passes through untouched — a real read failure reported as
    // anything else would be the worse bug (cubic review, PR #272).
    throw nowAborted(abortSignal) ? abortSignal.reason : cause
  }
  finally {
    // Hygiene rather than a guard: one signal serves a whole turn of reads, and a listener
    // left on it per read accumulates for as long as the caller holds the signal.
    abortSignal?.removeEventListener('abort', release)
  }
}

/**
 * Whether the signal has fired *as of now*, asked again rather than answered from before.
 *
 * A call rather than `abortSignal?.aborted === true` spelled inline, and not for taste:
 * {@link collect}'s own pre-check narrows that property to `false` for the rest of the
 * function, so TypeScript rejects the later comparison as one that "appears to be
 * unintentional" (TS2367). It is not unintentional — it is the point. `aborted` flips while
 * the drain is suspended in `await reader.read()`, which is precisely the window the listener
 * and this catch exist for, and no narrowing taken before that `await` can speak for what is
 * true after it. The type predicate re-asks the question and hands back the signal itself, so
 * the reason can be read from it.
 */
function nowAborted(abortSignal: AbortSignal | undefined): abortSignal is AbortSignal {
  return abortSignal?.aborted === true
}

/** One array from many, sized up front so the chunks are copied exactly once. */
function concat(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.length
  }
  return bytes
}

/** Bytes → base64, chunked so a large payload does not overflow the argument stack. */
export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK))
  }
  return btoa(binary)
}
