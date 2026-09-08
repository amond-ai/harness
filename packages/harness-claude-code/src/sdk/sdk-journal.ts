/**
 * Reading a finished `sdk` turn's record back out of the sandbox.
 *
 * The settle path replays *the process log*, and under the `cli` driver that log is the turn:
 * `claude --output-format stream-json` writes the NDJSON straight to stdout. A turn host writes
 * nothing of the sort there — its stdout carries `bridge-ready` and whatever the SDK printed —
 * so a settle that read it would find no `result` message and record every `sdk` run as failed
 * ("claude produced no terminal result message"). The record is on disk instead, in the journal
 * the host appends every outbound frame to, and this is the read that turns it back into the
 * same NDJSON every existing consumer already decodes.
 *
 * Import-free — the classifier, the demuxer and the contract's types are all reachable from
 * `bun test`, and the sandbox is touched only through {@link SandboxSession}. Both readers of the
 * journal go through {@link readJournalTail}: `replay-turn.ts` at settle, and `sdk-round.ts` when
 * a round finds the host gone and has to ask whether it ended before it went.
 */
import type { ProcessExit, SandboxCommand, SandboxProcessHandle, SandboxSession } from '@amond-ai/sandbox'
import type { ProcessSideChannel } from '../process-ndjson'
import type { TerminalObservation } from './sdk-frames'
import { describeCause } from '@amond-ai/redact'
import { LIVE_MIRROR_MAX_BYTES } from '../mirror'
import { demuxProcessEvents, iterateStream } from '../process-ndjson'
import { classifyFrame } from './sdk-frames'

/**
 * How much of the journal's tail is read into the Worker.
 *
 * The same bound the live mirror ingests a whole turn's transcript under
 * ({@link LIVE_MIRROR_MAX_BYTES}), because it is the same isolate holding the same kind of
 * string for the same turn — a second, larger number here would let the settle path exceed a
 * limit the live path was tuned to survive. The *tail* rather than the head: the window folds
 * the last messages and `runFailure` reads the terminal `result`, which is the last frame of all.
 */
export const MAX_JOURNAL_BYTES = LIVE_MIRROR_MAX_BYTES

/**
 * `tail -c` rather than a whole-file read: the journal is unbounded and a `readFile` of it would
 * be the one allocation neither the contract nor the isolate bounds.
 */
export function journalTailArgv(journalPath: string): SandboxCommand {
  return ['tail', '-c', String(MAX_JOURNAL_BYTES), journalPath]
}

/**
 * The journal's frames, as the transcript the message window decodes.
 *
 * Only `raw` frames carry the SDK's own messages, and one `raw` is one NDJSON line — the same
 * mapping the live round makes, through the same classifier, so the mirrored transcript and the
 * replayed one cannot drift apart.
 *
 * `cut` says the read may have started mid-line, which `tail -c` makes likely rather than
 * exceptional; that first line is dropped rather than parsed, because half a JSON object is
 * indistinguishable from a corrupt one and the alternative is a warning on every capped turn.
 */
export function sdkJournalTranscript(text: string, cut: boolean): string {
  const lines = text.split('\n')
  if (cut) {
    lines.shift()
  }
  let transcript = ''
  for (const line of lines) {
    if (line.trim() === '') {
      continue
    }
    const effect = classifyFrame(line)
    if (effect.kind === 'transcript') {
      transcript += effect.line
    }
  }
  return transcript
}

/**
 * How long the bounded journal read may take. Generous for a `tail -c` of a local file, and
 * bounded because the alternative is a settle that never ends.
 */
export const JOURNAL_TAIL_TIMEOUT_MS = 30_000

/** One `tail -c` of the journal: its text, whether the read hit the bound, and the tail's own ends. */
export interface JournalTail {
  text: string
  /** The read started mid-line — {@link sdkJournalTranscript} drops that first line. */
  cut: boolean
  sideChannel: ProcessSideChannel
}

/**
 * Read the journal's tail out of the sandbox.
 *
 * The exit is awaited before the log is read, exactly as a materialization's is: `await exec`
 * means the process *started*, so reading its log first can drain a stream `tail` has not written
 * to yet — and an empty transcript decodes to no terminal `result`, settling a turn that
 * succeeded as failed. A non-zero exit is raised rather than returned empty, for the same reason:
 * "the journal could not be read" and "the turn produced nothing" are different facts and only
 * one of them is the turn's.
 */
export async function readJournalTail(session: SandboxSession, journalPath: string): Promise<JournalTail> {
  const process = await session.exec(journalTailArgv(journalPath))
  const exit = await journalTailExit(process, journalPath)
  if (exit.code !== 0) {
    throw new Error(`turn host journal '${journalPath}' could not be read: tail exited with code ${String(exit.code)}`)
  }
  const { stdout, sideChannel } = demuxProcessEvents(iterateStream(await process.logs({
    replay: true,
    follow: false,
  })))
  let bytes = 0
  let text = ''
  const decoder = new TextDecoder()
  for await (const chunk of iterateStream(stdout)) {
    bytes += chunk.byteLength
    text += decoder.decode(chunk, { stream: true })
  }
  // The flush: a multi-byte character split across the last two chunks is held by the decoder
  // until it is told the stream ended, and an unflushed tail byte is a corrupted final line.
  text += decoder.decode()
  return { text, cut: bytes >= MAX_JOURNAL_BYTES, sideChannel }
}

/** The tail's own ending, named: a wait that did not settle is not an empty journal. */
async function journalTailExit(process: SandboxProcessHandle, journalPath: string): Promise<ProcessExit> {
  try {
    return await process.waitForExit({ timeout: JOURNAL_TAIL_TIMEOUT_MS })
  }
  catch (cause) {
    await process.kill().catch(() => {})
    throw new Error(`turn host journal '${journalPath}' could not be read: ${describeCause(cause)}`)
  }
}

/**
 * The last terminal frame the journal holds, if it holds one.
 *
 * A host can journal its `finish` and exit before that frame reaches the Worker — the socket is
 * lost in between — and a round that read only "the process is gone" would call a completed turn
 * an unnamed timeout, which outranks the replayed transcript at settle. The journal is the record
 * the host wrote before it went, so this is the same question asked of the source that survived.
 */
export function journalTerminal(text: string, cut: boolean): TerminalObservation | undefined {
  const lines = text.split('\n')
  if (cut) {
    lines.shift()
  }
  let last: TerminalObservation | undefined
  for (const line of lines) {
    if (line.trim() === '') {
      continue
    }
    const effect = classifyFrame(line)
    if (effect.kind === 'terminal') {
      last = effect.observation
    }
  }
  return last
}
