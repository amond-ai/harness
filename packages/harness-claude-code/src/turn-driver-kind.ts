/**
 * Which driver runs a turn: the `claude` CLI exec this Worker has always used, or the Agent
 * SDK turn host (ADR "turns run through the Agent SDK in a turn host", D3).
 *
 * Split from the driver modules the way `sandbox-backend.ts` is split from
 * `sandbox-provider.ts`, and for the same reason in reverse: nothing here imports anything,
 * so `bun test` reaches the parser whatever the drivers themselves end up depending on.
 *
 * A separate axis from `SANDBOX_BACKEND`, deliberately: that var names the *provider*, and the
 * driver is orthogonal to it — `e2b × sdk` is an expected combination rather than an exception.
 *
 * The default is `sdk` since the ADR's phase 6 gate passed (workerd parity suite green under
 * both drivers, one live run per kind on the provider of record); before that it was `cli`, so
 * an unset var could not move production onto a driver whose parity had not been shown. `cli`
 * stays selectable as the fallback. An *unknown* value throws instead, on the same reasoning as
 * `parseSandboxBackend` — a misspelled driver is a misconfiguration, and silently running a
 * driver the operator did not name would hide it until someone wondered why the turn host never
 * started, or why it did.
 */

export const TURN_DRIVERS = ['cli', 'sdk'] as const

export type TurnDriverKind = typeof TURN_DRIVERS[number]

export function parseTurnDriver(raw: string | undefined): TurnDriverKind {
  const value = raw?.trim() ?? ''
  if (value === '') {
    return 'sdk'
  }
  if (!(TURN_DRIVERS as readonly string[]).includes(value)) {
    throw new Error(
      `TURN_DRIVER has an unknown turn driver '${value}': expected one of ${TURN_DRIVERS.join(', ')}`,
    )
  }
  return value as TurnDriverKind
}
