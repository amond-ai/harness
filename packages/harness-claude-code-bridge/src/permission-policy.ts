/*
 * The run's permission posture (ADR D6), enforced inside the host.
 *
 * Two layers live here. The `PreToolUse` hook is the one that matters in
 * production: the SDK's evaluation order is hooks → deny rules → ask rules →
 * mode → allow rules → `canUseTool`, and this deployment runs with the mode
 * stage allowing everything, so a refuse list installed on `canUseTool` alone
 * would be a silent no-op. `canUseTool` is still installed for every mode as
 * the belt-and-braces for postures that do reach it — and it never pends,
 * because a headless turn must not wait forever on a callback that is allowed
 * to.
 *
 * A replayed answer is matched on the tool name and the structurally equal
 * input — the action a human actually approved — rather than on the deferred
 * call's `tool_use_id`. Keying on the id would be tighter, but only if the CLI
 * re-issues the deferred call under the same id when the turn resumes, and that
 * is an observation the first live run owes us before this file depends on it.
 */

import type { ApprovedRequest, DeniedRequest } from '@pleaseai/harness-protocol'

/** What a denial with no words of its own tells the agent. */
export const DENIED_BY_REVIEWER_MESSAGE = 'denied by a human reviewer'

/** What the host answers when a tool call reaches `canUseTool` under `deny`. */
export const DENY_BY_RUN_POLICY_MESSAGE
  = 'denied by run policy (approvalPolicy=deny)'

/**
 * Exact tool name, or a trailing-`*` prefix match (`mcp__github__*`). Nothing
 * else: patterns come from run config, and a regex there would be a footgun.
 */
export function matchesToolPattern(pattern: string, toolName: string): boolean {
  if (pattern.endsWith('*')) {
    return toolName.startsWith(pattern.slice(0, -1))
  }
  return pattern === toolName
}

function matchesAny(
  patterns: readonly string[] | undefined,
  toolName: string,
): boolean {
  return patterns?.some(pattern => matchesToolPattern(pattern, toolName))
    ?? false
}

/** Structural equality over JSON-shaped values. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true
  }
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false
  }
  const aKeys = Object.keys(a as Record<string, unknown>)
  const bKeys = Object.keys(b as Record<string, unknown>)
  if (aKeys.length !== bKeys.length) {
    return false
  }
  return aKeys.every(
    key =>
      Object.hasOwn(b as Record<string, unknown>, key)
      && deepEqual(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
      ),
  )
}

export type PreToolUseDecision = 'allow' | 'deny' | 'defer'

export interface PreToolUsePolicy {
  refuseTools?: readonly string[]
  deferTools?: readonly string[]
  approvedRequests?: readonly ApprovedRequest[]
  deniedRequests?: readonly DeniedRequest[]
}

export interface PreToolUseOutcome {
  permissionDecision: PreToolUseDecision
  permissionDecisionReason: string
}

/**
 * Evaluate one tool call against the run policy. Order is load-bearing:
 * a human's answer must beat the rule that deferred the call, or the resumed
 * turn defers the same call forever. An answer is consumed on use — it
 * authorizes (or refuses) one request, not the tool.
 *
 * Denials are read **before** approvals, not after, and a call matching both
 * lists consumes **both** entries. A contradiction the Worker should never
 * send is refused — the only reading of it that cannot turn a mistake into an
 * unauthorized tool call — and voiding the approval with it is what keeps that
 * true for the call *after*: leaving the approval on the list would let an
 * identical retry, which the agent is free to make once it is told no, be
 * allowed by the half of the contradiction that was skipped.
 * Both come before the defer rule, for the reason the ADR states: the resumed
 * call matches the very `deferTools` pattern that deferred it, so an answer
 * that did not beat that rule would defer forever — and a *denied* call left
 * to defer is a human's "no" the agent never hears.
 */
export function createPreToolUseEvaluator(
  policy: PreToolUsePolicy,
): (input: {
  toolName: string
  toolInput: unknown
}) => PreToolUseOutcome | undefined {
  const remainingApprovals = [...(policy.approvedRequests ?? [])]
  const remainingDenials = [...(policy.deniedRequests ?? [])]

  return ({ toolName, toolInput }) => {
    const denialIndex = remainingDenials.findIndex(
      denial => denial.name === toolName && deepEqual(denial.input, toolInput),
    )
    if (denialIndex >= 0) {
      const [denial] = remainingDenials.splice(denialIndex, 1)
      const contradicted = remainingApprovals.findIndex(
        approval =>
          approval.name === toolName && deepEqual(approval.input, toolInput),
      )
      if (contradicted >= 0) {
        remainingApprovals.splice(contradicted, 1)
      }
      return {
        permissionDecision: 'deny',
        permissionDecisionReason:
          `${denial.reason?.trim() || DENIED_BY_REVIEWER_MESSAGE} (request ${denial.id})`,
      }
    }

    const approvalIndex = remainingApprovals.findIndex(
      approval =>
        approval.name === toolName && deepEqual(approval.input, toolInput),
    )
    if (approvalIndex >= 0) {
      const [approval] = remainingApprovals.splice(approvalIndex, 1)
      return {
        permissionDecision: 'allow',
        permissionDecisionReason: `approved out of band (request ${approval.id})`,
      }
    }

    if (matchesAny(policy.refuseTools, toolName)) {
      return {
        permissionDecision: 'deny',
        permissionDecisionReason: `refused by run policy (refuseTools matched ${toolName})`,
      }
    }

    if (matchesAny(policy.deferTools, toolName)) {
      return {
        permissionDecision: 'defer',
        permissionDecisionReason: `deferred by run policy (deferTools matched ${toolName})`,
      }
    }

    return undefined
  }
}
