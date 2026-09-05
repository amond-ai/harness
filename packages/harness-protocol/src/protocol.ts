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
import { harnessV1BridgeInboundCommandSchemas } from './harness-v1/harness-v1-bridge-protocol'

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
