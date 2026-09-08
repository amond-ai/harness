/**
 * Permission modes the in-container `claude` CLI accepts, mirrored from the Agent SDK's
 * `PermissionMode` union. Mirrored rather than imported because this module must stay
 * import-free to remain readable from `bun test`, and the SDK is only a transitive
 * dependency here (it reaches the sandbox through `@pleaseai/sandbox-bridge`).
 *
 * **Which mode a deployment runs, and what that costs, is not decided here.** This module only
 * refuses a mode it does not recognise; the FR-012 trust posture — why the turn runs
 * unconstrained, the network boundary it runs behind, the residual risks accepted in exchange,
 * and the successor controls that would change the answer — is recorded once, next to
 * `CLAUDE_PERMISSION_MODE` in `wrangler.jsonc`, and pinned by `trust-posture.test.ts`. A second
 * copy here would be a second thing to keep in step with the value it explains.
 */

export const PERMISSION_MODES = ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'auto'] as const

export type PermissionMode = typeof PERMISSION_MODES[number]

/**
 * FR-012: the trust posture a sandboxed turn runs under is an explicit, recorded value.
 * An unset or misspelled var therefore fails the run instead of silently inheriting the
 * spike's `bypassPermissions`.
 */
export function parsePermissionMode(raw: string | undefined): PermissionMode {
  if (raw === undefined || raw === '') {
    throw new Error(`CLAUDE_PERMISSION_MODE is not set: the permission mode must be configured explicitly (one of ${PERMISSION_MODES.join(', ')})`)
  }
  if (!(PERMISSION_MODES as readonly string[]).includes(raw)) {
    throw new Error(`CLAUDE_PERMISSION_MODE has an unknown permission mode '${raw}': expected one of ${PERMISSION_MODES.join(', ')}`)
  }
  return raw as PermissionMode
}
