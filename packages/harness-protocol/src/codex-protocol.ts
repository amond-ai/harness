/*
 * The Codex bridge's `start` vocabulary and the endings it reports.
 *
 * Everything shared with upstream is vendored, not restated:
 * `codex-bridge-protocol.ts` (Codex's `start` shape) and `harness-v1/` (the bridge protocol it
 * extends) are byte-identical copies — see UPSTREAM.md. This file holds only what this deployment
 * adds on top, composed the way `protocol.ts` composes Claude's.
 *
 * Reached through the `./codex` entry point, never the package root: the root carries Claude's
 * `startMessageSchema` under the same name, and it is on the critical path of a bundle that has no
 * business carrying Codex's schemas. Two entries keep each bridge's bundle to its own adapter by
 * construction rather than by hoping a tree-shaker drops a `z.object(…)` call.
 */

import { z } from 'zod/v4'
import {
  bridgeErrorPhaseSchema,
  interruptInboundSchema,
  interruptReasonSchema,
  stoppedReasonSchema,
  turnHostStartedSchema,
} from './bridge-extensions'
import { startMessageSchema as codexStartMessageSchema } from './codex-bridge-protocol'
import { harnessV1BridgeInboundCommandSchemas, harnessV1BridgeOutboundMessageSchema } from './harness-v1/harness-v1-bridge-protocol'
import { harnessV1ErrorPartSchema, harnessV1FinishPartSchema } from './harness-v1/harness-v1-stream-part'

export { bridgeReadySchema } from './codex-bridge-protocol'
export type { BridgeReady } from './codex-bridge-protocol'

/**
 * Codex's `start`, unchanged from upstream.
 *
 * Nothing added on top yet, deliberately. The Claude host's `start` grew a dozen fields because
 * each arrived with the code that reads it; a field declared here before a bridge consumes it
 * would be a schema this deployment has to keep accepting for a behaviour it never shipped.
 */
export const startMessageSchema = codexStartMessageSchema

export type StartMessage = z.infer<typeof startMessageSchema>

/**
 * The commands a Codex bridge accepts: the shared set, plus `interrupt`.
 *
 * `interrupt` is not optional. The bridge runtime routes it to whatever handler the turn
 * registered and answers an unhandled one with a control-frame error, so every bridge built on
 * that runtime speaks it on the wire whether or not its adapter has anything to do.
 */
export const inboundCommandSchemas = [
  ...harnessV1BridgeInboundCommandSchemas,
  interruptInboundSchema,
] as const

export const inboundMessageSchema = z.discriminatedUnion('type', [
  startMessageSchema,
  ...inboundCommandSchemas,
])

export type InboundMessage = z.infer<typeof inboundMessageSchema>

/**
 * `finish`, with the fields a Codex bridge adds — and why the extension has to exist.
 *
 * The vendored `harnessV1FinishPartSchema` is a plain `z.object`, and a plain `z.object` **strips**
 * keys it does not declare. A client that validated this bridge's `finish` against the upstream
 * union would parse it successfully and receive it with every field below silently deleted, which
 * matters most for `stopped`: the host hardcodes `finishReason` to `stop` on every ending, so a
 * `finish` that lost `stopped` is byte-identical to a completed turn.
 *
 * Three differences from Claude's `turnHostFinishSchema`, each of them a deliberate absence:
 *
 * - **No `deferredToolUse`.** The bridge runs Codex under `approvalPolicy: 'never'`, so a turn
 *   never parks on an approval and the field would be structurally unreachable — an optional key
 *   that is never present is one every consumer has to learn is a lie.
 * - **No `sessionArtifacts` envelope.** Two of its three fields name a session *file*, and Codex's
 *   resume coordinate is a thread id that already rides the shared `bridge-thread` frame. Putting
 *   a thread id in a field whose documentation promises a `<sessionId>.jsonl` beside it would be
 *   worse than naming a new one.
 * - **`journalPath` flat, and optional.** It is the runtime's own property, taken from the event
 *   log it opened with no adapter involvement, so it rides the frame as itself rather than wrapped
 *   in an adapter-shaped envelope.
 */
export const codexTurnHostFinishSchema = harnessV1FinishPartSchema.extend({
  stopped: stoppedReasonSchema.optional(),
  /** Absolute path of the turn's journal, as the runtime opened it. */
  journalPath: z.string().optional(),
  /**
   * The interrupt this host acted on, echoed back to the client that asked for it.
   *
   * Present only beside `stopped: 'interrupted'`, and only when that stop was a client
   * `interrupt`: a turn the runtime aborted on its own ends early too and carries none, because
   * there is no reason to name.
   *
   * A value outside the enum degrades to "no echo" rather than failing the frame: a host newer
   * than this client can name a fourth reason, and refusing the whole `finish` over a field the
   * client only reads as a hint would cost it `stopped` too — an unreadable ending is far worse
   * than an unnamed one.
   */
  interruptedBy: interruptReasonSchema.optional().catch(undefined),
})

export type CodexTurnHostFinish = z.infer<typeof codexTurnHostFinishSchema>

export const codexTurnHostErrorSchema = harnessV1ErrorPartSchema.extend({
  phase: bridgeErrorPhaseSchema.optional(),
  /** The same journal `finish` reports, on the ending that is not a finish. */
  journalPath: z.string().optional(),
  /** The interrupt this host was answering when the error happened; see `finish`'s. */
  interruptedBy: interruptReasonSchema.optional().catch(undefined),
})

export type CodexTurnHostError = z.infer<typeof codexTurnHostErrorSchema>

/**
 * Every frame a Codex bridge can send, with `finish` and `error` in their extended form, plus
 * `bridge-started`.
 *
 * Built by substitution rather than by `.extend()` on the union — a discriminated union has no
 * such method — so the two replaced members are removed by `type` and the extended ones added
 * back. A member added upstream therefore arrives here automatically, which is how `bridge-thread`
 * (the frame carrying Codex's resume coordinate) and `file-change` reach this union without being
 * named.
 */
export const codexTurnHostOutboundMessageSchema = z.discriminatedUnion('type', [
  ...harnessV1BridgeOutboundMessageSchema.options.filter(
    option => !['finish', 'error'].includes(option.shape.type.value as string),
  ),
  codexTurnHostFinishSchema,
  codexTurnHostErrorSchema,
  turnHostStartedSchema,
] as unknown as [z.ZodObject, ...z.ZodObject[]])

export type CodexTurnHostOutboundMessage = z.infer<typeof codexTurnHostOutboundMessageSchema>
