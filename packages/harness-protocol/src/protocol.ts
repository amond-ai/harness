/*
 * The turn host's `start` payload and inbound vocabulary.
 *
 * Everything shared with upstream is vendored, not restated:
 * `claude-code-bridge-protocol.ts` (Claude's `start` shape) and
 * `harness-v1/` (the bridge protocol it extends) are byte-identical copies —
 * see UPSTREAM.md. This file holds only what this host adds on top, composed
 * the way upstream composes: `harnessV1BridgeStartBaseSchema` → the Claude
 * fields → the fields below.
 */

import { z } from 'zod/v4'
import {
  bridgeErrorPhaseSchema,
  interruptInboundSchema,
  interruptReasonSchema,
  stoppedReasonSchema,
  turnHostStartedSchema,
} from './bridge-extensions'
import { startMessageSchema as claudeCodeStartMessageSchema } from './claude-code-bridge-protocol'
import {
  harnessV1BridgeInboundCommandSchemas,
  harnessV1BridgeOutboundMessageSchema,
} from './harness-v1/harness-v1-bridge-protocol'
import {
  harnessV1ErrorPartSchema,
  harnessV1FinishPartSchema,
} from './harness-v1/harness-v1-stream-part'

/*
 * The agent-agnostic half lives in `bridge-extensions.ts` and is re-exported here rather than
 * moved out of reach: it was defined in this file until the bridge runtime became its own package,
 * and every consumer imports it from the package root.
 */
export {
  bridgeErrorPhaseSchema,
  interruptInboundSchema,
  interruptReasonSchema,
  stoppedReasonSchema,
  turnHostStartedSchema,
} from './bridge-extensions'
export type {
  BridgeErrorPhase,
  InterruptReason,
  StoppedReason,
  TurnHostStarted,
} from './bridge-extensions'
export {
  bridgeReadySchema,
  outboundMessageSchema,
} from './claude-code-bridge-protocol'
export type {
  BridgeReady,
  OutboundMessage,
} from './claude-code-bridge-protocol'

/**
 * The Agent SDK's own permission modes. The Worker sends one of these; the
 * harness trio on `harnessV1BridgeStartBaseSchema` stays accepted so an
 * `@ai-sdk/harness` client still drives this host. `bypassPermissions`
 * additionally sets `allowDangerouslySkipPermissions`.
 */
export const sdkPermissionModeSchema = z.enum([
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
])

export type SdkPermissionMode = z.infer<typeof sdkPermissionModeSchema>

export const settingSourceSchema = z.enum(['user', 'project', 'local'])

/**
 * A tool-name pattern: an exact native name (`Bash`) or a trailing-`*`
 * wildcard (`mcp__github__*`). Nothing else — no regex, no leading wildcard.
 */
export const toolPatternSchema = z.string()

/**
 * One approval a human granted out of band, replayed into the resumed turn.
 * The `PreToolUse` hook allows a call whose tool name matches `name` and whose
 * input deep-equals `input`, once — an answer authorizes one request, not the
 * tool.
 */
export const approvedRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})

export type ApprovedRequest = z.infer<typeof approvedRequestSchema>

/**
 * One request a human refused, replayed into the resumed turn.
 *
 * The counterpart of {@link approvedRequestSchema}, and it exists for the ending the ADR calls
 * out: a deferral a human answered *no* to must be heard by the agent, not deferred a second
 * time. The `PreToolUse` hook denies a call whose tool name matches `name` and whose input
 * deep-equals `input`, once, and it checks this list before the approvals and before the defer
 * rule — so a call that was both approved and denied is denied, which is the safe reading of a
 * contradiction the Worker should never send.
 */
export const deniedRequestSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
  /** The human's own words, or the synthesized reason for a timeout; shown to the agent. */
  reason: z.string().optional(),
})

export type DeniedRequest = z.infer<typeof deniedRequestSchema>

export const startMessageSchema = claudeCodeStartMessageSchema.extend({
  /*
   * Upstream declares `thinking` without `.optional()`, so its schema refuses
   * every `start` that omits it. Reuse the vendored shape and make it optional
   * rather than restating the union.
   */
  thinking: claudeCodeStartMessageSchema.shape.thinking.optional(),

  /*
   * The Worker may send an Agent SDK mode as well as the harness trio the base
   * schema allows.
   */
  permissionMode: z
    .union([
      claudeCodeStartMessageSchema.shape.permissionMode.unwrap(),
      sdkPermissionModeSchema,
    ])
    .optional(),

  /*
   * Token deltas. `true` (the default) asks the SDK for partial messages and
   * streams them as live-only frames. `false` means no `stream_event` reaches
   * the host at all — liveness then comes from complete messages, which is
   * what a long turn wants when the Worker's per-step CPU meter is the
   * binding constraint.
   */
  emitDeltas: z.boolean().optional(),

  /*
   * SDK options the Worker owns. Each maps 1:1 onto a `query()` option; the
   * host validates and forwards, it does not second-guess.
   */
  settingSources: z.array(settingSourceSchema).optional(),
  persistSession: z.boolean().optional(),
  pathToClaudeCodeExecutable: z.string().optional(),
  maxBudgetUsd: z.number().optional(),
  sessionId: z.string().optional(),
  resume: z.string().optional(),

  /*
   * Run permission posture (D6). `refuseTools` and `deferTools` are patterns
   * the `PreToolUse` hook denies / defers; `approvedRequests` are one-shot
   * allows replayed after a human answered out of band, and beat both.
   * `approvalPolicy` decides what `canUseTool` does when it is reached at all:
   * `deny` answers immediately (a headless turn must never wait on a callback
   * that can pend forever), `forward` runs the request/response round-trip.
   */
  refuseTools: z.array(toolPatternSchema).optional(),
  deferTools: z.array(toolPatternSchema).optional(),
  approvedRequests: z.array(approvedRequestSchema).optional(),
  /**
   * One-shot denials, replayed for the same reason the approvals are and checked ahead of them:
   * without this the resumed call matches the same `deferTools` pattern that deferred it and
   * defers forever, so a human's "no" would be indistinguishable from no answer at all.
   */
  deniedRequests: z.array(deniedRequestSchema).optional(),
  approvalPolicy: z.enum(['deny', 'forward']).optional(),

  /**
   * How long the host waits for the SDK's `result` after an `interrupt`
   * before aborting the query and exiting non-zero. Defaults to 30 s.
   */
  interruptGraceMs: z.number().optional(),
})

export type StartMessage = z.infer<typeof startMessageSchema>

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
 * Where a turn's two durable artifacts ended up, as the host resolved them.
 *
 * The Worker never reconstructs `~/.claude/projects/<encoded-cwd>` itself: that encoding is a
 * CLI implementation detail, and the host is the process pinned to the same CLI patch as the
 * SDK it runs (`session-artifacts.ts`).
 */
export const sessionArtifactsSchema = z.object({
  /**
   * The session the turn ran as — what a later attempt passes back as `start.resume`.
   *
   * Beside the transcript path rather than derived from it: the Worker restores the file by the
   * path the host named and resumes by the id the host named, and reading the id out of the
   * filename would make the `<sessionId>.jsonl` convention a Worker-side assumption about a
   * CLI implementation detail this schema exists to keep on the host's side.
   *
   * Absent for the same reason the path is: under `persistSession: false` there is no session
   * to resume, and a host that never reached `system`/`init` has no id to report.
   */
  sessionId: z.string().optional(),
  /** Absent under `persistSession: false`, where the SDK writes no session file at all. */
  sessionTranscriptPath: z.string().optional(),
  journalPath: z.string(),
})

export type SessionArtifacts = z.infer<typeof sessionArtifactsSchema>

/**
 * `finish`, with the fields this host adds — and the reason this extension exists at all.
 *
 * The vendored `harnessV1FinishPartSchema` is a plain `z.object`, and a plain `z.object`
 * **strips** keys it does not declare. So a Worker that validated the host's `finish` against
 * the upstream union would parse it successfully and receive it with `stopped` and
 * `sessionArtifacts` silently deleted — the two fields the attempt outcome is decided from.
 * Measured, not inferred: `safeParse` of a `finish` carrying both answers `success: true` with
 * neither present in `data`.
 *
 * Extended here rather than in the Worker for the reason `startMessageSchema` is: the host
 * emits these frames and the Worker validates them, so one definition serves both ends of one
 * wire.
 */
/**
 * The call a `stopped: 'deferred'` turn stopped on — the SDK's `deferred_tool_use`, verbatim.
 *
 * Carried on `finish` because `stopped` alone says only *that* a decision is owed, not what it
 * is owed about, and the whole of layer 3 is that the answer authorizes **one request**: the
 * Worker posts this id out of band, matches the human's answer against it, and replays the
 * request as an `approvedRequests` / `deniedRequests` entry on the next `start`. Absent from
 * every other ending, and absent from a `deferred` one only if the host is older than this
 * field — which the Worker reads as protocol drift rather than as a deferral it can act on.
 */
export const deferredToolUseSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
})

export type DeferredToolUse = z.infer<typeof deferredToolUseSchema>

export const turnHostFinishSchema = harnessV1FinishPartSchema.extend({
  stopped: stoppedReasonSchema.optional(),
  sessionArtifacts: sessionArtifactsSchema.optional(),
  deferredToolUse: deferredToolUseSchema.optional(),
  /**
   * The interrupt this host acted on, echoed back to the client that asked for it.
   *
   * Present only beside `stopped: 'interrupted'`, and only when that stop was a client
   * `interrupt`: an SDK abort nobody asked for ends the turn early too, and it carries none
   * because there is no reason to name. Absent from a host older than this field — the client
   * then falls back to its own memory of the stop it sent, and to inference where that memory
   * did not survive.
   *
   * A value outside the enum degrades to "no echo" rather than failing the frame: a host newer
   * than this client can name a fourth reason, and refusing the whole `finish` over a field the
   * client only reads as a hint would cost it `stopped` and `sessionArtifacts` too — an
   * unreadable ending is far worse than an unnamed one.
   */
  interruptedBy: interruptReasonSchema.optional().catch(undefined),
})

export type TurnHostFinish = z.infer<typeof turnHostFinishSchema>

export const turnHostErrorSchema = harnessV1ErrorPartSchema.extend({
  phase: bridgeErrorPhaseSchema.optional(),
  /**
   * The same artifacts `finish` reports, on the ending that is *not* a finish.
   *
   * A run-phase `error` is the ordinary way a turn fails, and by then `system`/`init` has long
   * since named a session — so the attempt a client retries after one needs exactly these paths.
   * Absent from a `start`- or `init`-phase error, which happened before there was a session to
   * name, and from a host older than this field.
   */
  sessionArtifacts: sessionArtifactsSchema.optional(),
  /**
   * The interrupt this host was answering when the error happened.
   *
   * Present only on a run-phase `error` emitted after an `interrupt` was received — the host's
   * own escalation when no result arrived inside the grace, or a query failure during the
   * wind-down. Without it that frame is indistinguishable from a turn that failed on its own,
   * so a client reading one from a host older than this field leaves it the failure it looks
   * like rather than guessing. A value outside the enum degrades to "no echo" for the reason
   * `finish`'s does: the frame is worth more than the hint.
   */
  interruptedBy: interruptReasonSchema.optional().catch(undefined),
})

export type TurnHostError = z.infer<typeof turnHostErrorSchema>

/**
 * Every frame this host can send, with `finish` and `error` in their extended form, plus
 * `bridge-started`.
 *
 * Built by substitution rather than by `.extend()` on the union — a discriminated union has no
 * such method — so the two replaced members are removed by `type` and the extended ones added
 * back. A member added upstream therefore arrives here automatically; only the two this host
 * extends are named.
 */
export const turnHostOutboundMessageSchema = z.discriminatedUnion('type', [
  ...harnessV1BridgeOutboundMessageSchema.options.filter(
    option => !['finish', 'error'].includes(option.shape.type.value as string),
  ),
  turnHostFinishSchema,
  turnHostErrorSchema,
  turnHostStartedSchema,
] as unknown as [z.ZodObject, ...z.ZodObject[]])

export type TurnHostOutboundMessage = z.infer<typeof turnHostOutboundMessageSchema>
