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
 */

import type { ApprovedRequest } from '@pleaseai/harness-protocol'

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
}

export interface PreToolUseOutcome {
  permissionDecision: PreToolUseDecision
  permissionDecisionReason: string
}

/**
 * Evaluate one tool call against the run policy. Order is load-bearing:
 * a human's answer must beat the rule that deferred the call, or the resumed
 * turn defers the same call forever. An approval is consumed on use — it
 * authorizes one request, not the tool.
 */
export function createPreToolUseEvaluator(
  policy: PreToolUsePolicy,
): (input: {
  toolName: string
  toolInput: unknown
}) => PreToolUseOutcome | undefined {
  const remainingApprovals = [...(policy.approvedRequests ?? [])]

  return ({ toolName, toolInput }) => {
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
