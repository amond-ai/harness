/**
 * One host frame, as a `HarnessV1StreamPart` — or as nothing at all.
 *
 * The wire this adapter reads is the harness's own stream-part union *plus* what the bridge and
 * this deployment added to it (`@amond-ai/harness-protocol`): the connection's control frames,
 * the sandbox's captured output, and the four fields the host hangs off `finish` and `error`.
 * None of those is a stream part, and a consumer of `HarnessAgent` must never be handed one — so
 * this is a filter as much as a translation.
 *
 * Every emitted part is a value {@link harnessV1StreamPartSchema} accepted, never the frame it
 * came from. That is what keeps the host's extensions from leaking: `finish` carries `stopped`,
 * `sessionArtifacts`, `deferredToolUse` and `interruptedBy`, and a plain `z.object` *strips*
 * them, so validating is also the stripping. The artifacts are lifted out first — the adapter
 * keeps them as the session a later turn resumes by (ADR D8) — and everything else is dropped.
 */
import type { HarnessV1StreamPart } from '@ai-sdk/harness'
import type { DeferredToolUse, SessionArtifacts, TurnHostOutboundMessage } from '@amond-ai/harness-protocol/claude-code'
import { harnessV1StreamPartSchema } from '@amond-ai/harness-protocol/claude-code'

/**
 * How the host said the turn stopped, lifted off a `finish` before the strip removes it.
 *
 * Kept because the strip is otherwise lossy in the one direction that matters: `finishReason` is
 * hardcoded `stop` by the host on *every* ending, so a `finish` whose `stopped` has been deleted
 * is byte-identical to a completed one. Without this the adapter would report an interrupted,
 * timed-out or approval-parked turn as a clean completion.
 */
export interface TurnEnding {
  /** The host's own word: `completed`, `interrupted`, `deferred`, … */
  reason: string
  /** Which timer ended an interrupted turn, when the host named one. */
  interruptedBy?: string
  /** The tool call a `deferred` turn is parked on — the id the approval flow keys on. */
  deferredToolUse?: DeferredToolUse
}

/** What one frame contributed: a part to emit, artifacts to remember, or neither. */
export interface FrameTranslation {
  part?: HarnessV1StreamPart
  sessionArtifacts?: SessionArtifacts
  /** Present only on a `finish` that named a `stopped`; see {@link TurnEnding}. */
  ending?: TurnEnding
}

/**
 * The frames that belong to the connection rather than to the turn.
 *
 * Named rather than left to the schema to reject, because two of them would otherwise be
 * ambiguous: they are dropped because they are not the model's output, not because they failed
 * validation, and a reader of this list should not have to infer which.
 */
const BRIDGE_FRAMES = new Set([
  'bridge-hello',
  'bridge-ready',
  'bridge-started',
  'bridge-stop',
  'bridge-thread',
  'sandbox-log',
  'debug-event',
  'user-message-response',
])

/** The fields this host adds to `finish` and `error`; the harness contract knows none of them. */
const HOST_EXTENSIONS = ['stopped', 'sessionArtifacts', 'deferredToolUse', 'interruptedBy', 'phase'] as const

export function frameToPart(frame: TurnHostOutboundMessage): FrameTranslation {
  const record = { ...frame } as Record<string, unknown>
  if (BRIDGE_FRAMES.has(String(record.type))) {
    return {}
  }
  const artifacts = record.sessionArtifacts as SessionArtifacts | undefined
  const ending = endingOf(record)
  for (const key of HOST_EXTENSIONS) {
    delete record[key]
  }
  const validated = harnessV1StreamPartSchema.safeParse(record)
  return {
    ...(validated.success ? { part: validated.data as HarnessV1StreamPart } : {}),
    ...(artifacts === undefined ? {} : { sessionArtifacts: artifacts }),
    ...(ending === undefined ? {} : { ending }),
  }
}

/** The ending a `finish` named, or nothing — every other frame type carries none. */
function endingOf(record: Record<string, unknown>): TurnEnding | undefined {
  if (record.type !== 'finish' || typeof record.stopped !== 'string') {
    return undefined
  }
  return {
    reason: record.stopped,
    ...(typeof record.interruptedBy === 'string' ? { interruptedBy: record.interruptedBy } : {}),
    ...(record.deferredToolUse === undefined
      ? {}
      : { deferredToolUse: record.deferredToolUse as DeferredToolUse }),
  }
}
