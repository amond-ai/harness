/**
 * What one `HarnessV1` session hands back between turns, and what it accepts to pick one up.
 *
 * The whole of it is the driver's own vocabulary — a sandbox id, a {@link TurnHandle}, the round
 * cursor and the session artifacts the host reported — because that is exactly what a round
 * needs to attach again. Nothing is invented for the contract: `HarnessV1LifecycleState.data` is
 * an opaque JSON payload the framework only persists, so the honest payload is the state the
 * driver would otherwise have kept in a Workflow step result.
 *
 * Validated on the way *in* rather than trusted, because it comes back as JSON the framework
 * stored and a consumer may have round-tripped through a database. `lifecycleStateSchema` is the
 * adapter's promise that a payload it produced can be re-imported, and this is that promise.
 */
import type { HarnessV1PermissionMode } from '@ai-sdk/harness'
import type { PermissionMode } from '../permission-mode'
import { z } from 'zod'
import { TURN_TIMEOUT_CAUSES } from '../outcome'

/**
 * The handle a round dials with. It carries the per-turn channel token, which is why the state
 * is only ever handed back to the caller that owns the sandbox: the token authorises one bridge
 * port inside one container, and the payload never leaves that trust boundary.
 */
export const claudeCodeTurnHandleSchema = z.object({
  processId: z.string(),
  // Required, not optional as on `TurnHandle`: only the sdk driver's handles are ever exported
  // here, and every one of them carries all four. A continuation without a port or a token would
  // not fail at import but dial nothing, round after round, until the wall-clock budget ran out.
  startedAtMs: z.number(),
  port: z.number(),
  token: z.string(),
  bridgeStateDir: z.string(),
})

/**
 * The round cursor, plus the round counter the next slice continues from.
 *
 * `outcome` is deliberately absent: a state that carries one is a turn that ended, and a turn
 * that ended is not one anything continues.
 */
export const claudeCodeRoundSchema = z.object({
  since: z.number(),
  lastActivityAt: z.number(),
  round: z.number(),
  interruptedBy: z.enum(TURN_TIMEOUT_CAUSES).optional(),
  interruptedAt: z.number().optional(),
})

/** The two files the turn leaves behind, as the host named them (ADR D8). */
export const claudeCodeTurnSessionSchema = z.object({
  sessionId: z.string().optional(),
  transcriptPath: z.string().optional(),
  journalPath: z.string(),
})

export const claudeCodeLifecycleStateSchema = z.object({
  sandboxId: z.string(),
  /** Present on a `continue-turn` state; absent on a `resume-session` one, which has no turn. */
  handle: claudeCodeTurnHandleSchema.optional(),
  round: claudeCodeRoundSchema.optional(),
  /** Present once a terminal frame named artifacts — what a later turn resumes the session by. */
  session: claudeCodeTurnSessionSchema.optional(),
  attempt: z.number(),
})

export type ClaudeCodeLifecycleState = z.infer<typeof claudeCodeLifecycleStateSchema>
export type ClaudeCodeRoundCursor = z.infer<typeof claudeCodeRoundSchema>
export type ClaudeCodeTurnHandle = z.infer<typeof claudeCodeTurnHandleSchema>

/**
 * The harness's three postures over the CLI's six.
 *
 * A default rather than the mapping, because what a deployment trusts a turn with is its own
 * decision (FR-012): `CreateClaudeCodeOptions.permissionMode` replaces this wholesale. What the
 * default cannot do is *widen* — an absent mode stays `default`, the narrowest of the six.
 */
export function defaultPermissionMode(mode: HarnessV1PermissionMode | undefined): PermissionMode {
  switch (mode) {
    case 'allow-edits':
      return 'acceptEdits'
    case 'allow-all':
      return 'bypassPermissions'
    default:
      return 'default'
  }
}
