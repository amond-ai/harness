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
import { startMessageSchema as claudeCodeStartMessageSchema } from './claude-code-bridge-protocol'
import {
  harnessV1BridgeInboundCommandSchemas,
  harnessV1BridgeOutboundMessageSchema,
} from './harness-v1/harness-v1-bridge-protocol'
import {
  harnessV1ErrorPartSchema,
  harnessV1FinishPartSchema,
} from './harness-v1/harness-v1-stream-part'

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
  approvalPolicy: z.enum(['deny', 'forward']).optional(),

  /**
   * How long the host waits for the SDK's `result` after an `interrupt`
   * before aborting the query and exiting non-zero. Defaults to 30 s.
   */
  interruptGraceMs: z.number().optional(),
})

export type StartMessage = z.infer<typeof startMessageSchema>

/**
 * End the running turn early but keep it a turn: the host calls
 * `Query.interrupt()`, so the SDK still produces a `result` and the bridge
 * still emits `finish`. `abort` tears the process down instead.
 */
export const interruptInboundSchema = z.object({
  type: z.literal('interrupt'),
  reason: z.enum(['watchdog', 'budget', 'operator']),
})

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

/** How the turn ended, as the host judged it from the SDK's `terminal_reason`. */
export const stoppedReasonSchema = z.enum(['completed', 'interrupted', 'deferred'])

export type StoppedReason = z.infer<typeof stoppedReasonSchema>

/**
 * `finish`, with the two fields this host adds — and the reason this extension exists at all.
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
export const turnHostFinishSchema = harnessV1FinishPartSchema.extend({
  stopped: stoppedReasonSchema.optional(),
  sessionArtifacts: sessionArtifactsSchema.optional(),
})

export type TurnHostFinish = z.infer<typeof turnHostFinishSchema>

/** Which stage of the turn an `error` came from — stripped by the upstream schema, as above. */
export const bridgeErrorPhaseSchema = z.enum(['start', 'init', 'run'])

export type BridgeErrorPhase = z.infer<typeof bridgeErrorPhaseSchema>

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
})

export type TurnHostError = z.infer<typeof turnHostErrorSchema>

/**
 * The host's acknowledgement that a `start` was taken: sent the moment the bridge enters
 * `running`, before `query()` produces anything, so a client can tell "the turn is starting" from
 * "the model has not spoken yet". Journaled like every other frame, so it carries a `seq`.
 */
export const turnHostStartedSchema = z.object({ type: z.literal('bridge-started') })

export type TurnHostStarted = z.infer<typeof turnHostStartedSchema>

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
