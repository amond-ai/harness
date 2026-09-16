/**
 * One inbound bridge frame, validated and reduced to what the round loop acts on.
 *
 * Import-free, so `bun test` reaches the classification that decides a turn's outcome. The
 * schema is `@amond-ai/harness-protocol`'s extended union rather than the vendored one, and
 * that choice is load-bearing: the upstream `finish` and `error` are plain `z.object`s, so
 * validating with them *succeeds* and hands back a frame with `stopped`, `sessionArtifacts` and
 * `phase` silently deleted (`protocol.test.ts` pins the drop).
 *
 * Nothing here judges the turn. It says what a frame *is*; `sdk-round-state.ts` says what a
 * sequence of them means.
 */
import type { DeferredToolUse, InterruptReason, SessionArtifacts, StoppedReason } from '@amond-ai/harness-protocol/claude-code'
import { turnHostOutboundMessageSchema } from '@amond-ai/harness-protocol/claude-code'

/** How the turn ended, as one frame reported it. */
export type TerminalObservation
  = | {
    type: 'finish'
    stopped: StoppedReason
    sessionArtifacts?: SessionArtifacts
    /**
     * The call a `deferred` finish stopped on, when the host named one (D6 layer 3). Absent on
     * every other ending, and absent on a `deferred` one only from a host older than the field —
     * which `sdk-round-state.ts` reads as drift rather than as a deferral it can act on.
     */
    deferredToolUse?: DeferredToolUse
    /**
     * The interrupt the host acted on, when it echoed one (#388). Present only beside
     * `stopped: 'interrupted'` and only when the stop was a `interrupt` this Worker sent — an
     * SDK abort nobody asked for names none — and absent from a host older than the field.
     */
    interruptedBy?: InterruptReason
  }
    // On this member too, because a run-phase `error` is the ordinary way a turn fails and the
    // host has named a session by then (D8). A `start`- or `init`-phase one carries none: there
    // was no session yet.
    // `interruptedBy` on this member too, and it is the half the Worker could not infer: a
    // run-phase `error` after an interrupt is the host's escalation, which is otherwise
    // indistinguishable from a turn that failed on its own.
  | {
    type: 'error'
    phase: 'start' | 'init' | 'run'
    error: string
    sessionArtifacts?: SessionArtifacts
    interruptedBy?: InterruptReason
  }

/**
 * What one frame does to the round.
 *
 * `transcript` and `liveness` are separated because they are two different obligations: a
 * `raw` frame is the turn's record and has to reach the mirror as NDJSON, while a stream part
 * is only evidence that the turn is alive. Both reset the silence clock — D4 counts frame
 * arrival, not frame kind.
 */
export type FrameEffect
  = | { kind: 'hello', state?: string, lastSeq?: number }
    | { kind: 'transcript', seq?: number, line: string }
    | { kind: 'liveness', seq?: number }
    | { kind: 'log', stream: 'stdout' | 'stderr', line: string }
    | { kind: 'terminal', seq?: number, observation: TerminalObservation }
    | { kind: 'unreadable', reason: string }

/** Frames that are neither the record nor a signal: control acknowledgements and the like. */
const IGNORED_TYPES = new Set(['bridge-stop', 'bridge-thread', 'user-message-response', 'debug-event'])

/**
 * Classify one frame's text.
 *
 * A frame that will not parse is `unreadable` rather than thrown: the socket carries the turn's
 * whole record, and one malformed line must not end a turn that is otherwise running. The round
 * logs it and keeps reading, which is the same posture `demuxProcessEvents` takes on the cli
 * path.
 */
export function classifyFrame(text: string): FrameEffect {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  }
  catch (cause) {
    return { kind: 'unreadable', reason: `frame is not JSON: ${String(cause)}` }
  }
  if (!isRecord(parsed)) {
    // `JSON.parse` accepts `null`, a number and an array, and every read below assumes an object:
    // this function's contract is that a bad frame is *reported*, never thrown on.
    return { kind: 'unreadable', reason: 'frame is not an object' }
  }
  const validated = turnHostOutboundMessageSchema.safeParse(parsed)
  if (!validated.success) {
    const type = parsed.type
    if (typeof type === 'string' && IGNORED_TYPES.has(type)) {
      return { kind: 'liveness', seq: seqOf(parsed) }
    }
    return { kind: 'unreadable', reason: `frame '${String(type)}' failed validation` }
  }
  return effectOf(validated.data, seqOf(parsed))
}

/** A JSON object, as opposed to the other four things `JSON.parse` can hand back. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The runtime stamps `seq` on every frame it journals, but the schema does not declare it — so
 * it is read off the raw object rather than off the validated one, which strips it.
 */
function seqOf(parsed: Record<string, unknown>): number | undefined {
  const seq = parsed.seq
  return typeof seq === 'number' ? seq : undefined
}

// `Record<string, unknown>` rather than a discriminated frame type: the union's members carry
// their own shapes and this reads one field at a time, guarded, so the record is the honest
// description of what a validated frame is here.
function effectOf(frame: Record<string, unknown>, seq: number | undefined): FrameEffect {
  switch (frame.type as string) {
    case 'bridge-hello':
      return {
        kind: 'hello',
        state: typeof frame.state === 'string' ? frame.state : undefined,
        lastSeq: typeof frame.lastSeq === 'number' ? frame.lastSeq : undefined,
      }
    case 'raw':
      // The SDK's messages *are* the CLI's `stream-json` lines, so one `raw` re-emits one line
      // of the NDJSON every existing consumer already decodes (D2, "the same NDJSON").
      return { kind: 'transcript', seq, line: `${JSON.stringify(frame.rawValue)}\n` }
    case 'sandbox-log':
      return {
        kind: 'log',
        stream: frame.stream === 'stderr' ? 'stderr' : 'stdout',
        line: typeof frame.line === 'string' ? frame.line : '',
      }
    case 'finish':
      return {
        kind: 'terminal',
        seq,
        observation: {
          type: 'finish',
          // Absent only from a host older than the `stopped` patch; a turn that reached `finish`
          // without saying otherwise completed.
          stopped: (frame.stopped as StoppedReason | undefined) ?? 'completed',
          sessionArtifacts: frame.sessionArtifacts as SessionArtifacts | undefined,
          deferredToolUse: frame.deferredToolUse as DeferredToolUse | undefined,
          ...echoedInterrupt(frame),
        },
      }
    case 'error':
      return {
        kind: 'terminal',
        seq,
        observation: {
          type: 'error',
          phase: (frame.phase as 'start' | 'init' | 'run' | undefined) ?? 'run',
          error: describeFrameError(frame.error),
          sessionArtifacts: frame.sessionArtifacts as SessionArtifacts | undefined,
          ...echoedInterrupt(frame),
        },
      }
    default:
      return { kind: 'liveness', seq }
  }
}

/**
 * The host's echo of the interrupt it answered, as a spreadable fragment.
 *
 * The key is omitted rather than set to `undefined` when the frame carries none, so "this host
 * named no reason" — an older host, or an ending no stop preceded — stays distinguishable from
 * a reason that was read and lost.
 */
function echoedInterrupt(frame: Record<string, unknown>): { interruptedBy?: InterruptReason } {
  const reason = frame.interruptedBy
  return reason === undefined ? {} : { interruptedBy: reason as InterruptReason }
}

/** The `error` payload is `unknown` on the wire; render it without assuming a shape. */
function describeFrameError(error: unknown): string {
  if (typeof error === 'string') {
    return error
  }
  if (error !== null && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string') {
    return (error as { message: string }).message
  }
  return JSON.stringify(error) ?? 'unknown'
}
