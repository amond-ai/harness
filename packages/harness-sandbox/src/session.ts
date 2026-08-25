/**
 * One {@link HarnessV1NetworkSandboxSession} over one contract sandbox.
 *
 * The infra surface is where the two models diverge most, and each divergence is settled
 * here rather than pushed onto a backend:
 *
 * - **Ports are asked of the provider, not the session.** The contract puts `portEndpoint`
 *   on `SandboxProvider` on purpose — `SandboxSession` is satisfied by
 *   `@cloudflare/sandbox`'s own client with no mapping layer, and one added method would end
 *   that. So this session closes over the provider and its id.
 * - **`stop` and `destroy` are the same call.** The contract has one `destroy()`. The harness
 *   requires both to be idempotent and to survive an already-stopped sandbox, so a *successful*
 *   teardown is latched and concurrent callers share the one in flight. A failed one is not:
 *   a rejected promise left in the latch is replayed by every later call without ever
 *   reaching the backend again, so one transient RPC error would outlive itself and leave the
 *   sandbox unreapable for the life of the session. That is the bug `lazySession` already
 *   fixed once — "Memoise the acquisition, not its failure"
 *   (`packages/sandbox-e2b/src/provider.ts`, codex review, PR #260). Retrying is safe by the
 *   harness's own rule that `destroy` must handle an already-stopped sandbox, so a redundant
 *   second `destroy()` after a partial first is the right trade against a leaked sandbox.
 * - **`restricted()` is a separate object**, not this one narrowed by a type. The harness
 *   hands that view to user-tool `execute()` calls; a tool that reaches past the declared
 *   type must find nothing there, not a working `stop`.
 */
import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import type { SandboxProvider } from '@pleaseai/sandbox-contract'
import { createFileSurface } from './files'
import { createProcessSurface } from './process'

export interface HarnessSandboxSessionOptions {
  sandboxes: SandboxProvider
  /** The contract id this session is bound to — also the harness's durable resume key. */
  sandboxId: string
  /**
   * Where `run`/`spawn` resolve a relative command.
   *
   * The harness says to read this from the live sandbox and never hardcode it. The contract
   * has no call that answers it — nothing in `SandboxSession` reports the container's own
   * default — so it comes from whoever wired the backend, which is the party that knows the
   * image. Deviating in silence would read as an oversight; this is the deviation, stated.
   */
  defaultWorkingDirectory: string
  /** Ports the sandbox exposes, as the caller declared them at wiring time. */
  ports: readonly number[]
}

export function createHarnessSandboxSession(
  options: HarnessSandboxSessionOptions,
): HarnessV1NetworkSandboxSession {
  const { sandboxes, sandboxId, defaultWorkingDirectory, ports } = options
  const sandbox = sandboxes.session(sandboxId)

  const restricted = {
    ...createFileSurface(sandbox),
    ...createProcessSurface({ sandbox, defaultWorkingDirectory }),
    description: `Sandbox '${sandboxId}' on the ${sandboxes.backend} backend. `
      + `Working directory: ${defaultWorkingDirectory}. `
      + `Exposed ports: ${ports.length > 0 ? ports.join(', ') : 'none'}.`,
  }

  let teardown: Promise<void> | undefined
  const destroy = (): Promise<void> => (teardown ??= sandbox.destroy().catch((cause: unknown) => {
    // Cleared on rejection only, so a later `stop()`/`destroy()` actually retries while
    // callers racing the one in flight still share it.
    teardown = undefined
    throw cause
  }))

  const getPortEndpoint: HarnessV1NetworkSandboxSession['getPortEndpoint'] = ({ port, protocol }) =>
    sandboxes.portEndpoint(sandboxId, port, { protocol })

  return {
    ...restricted,
    id: sandboxId,
    defaultWorkingDirectory,
    ports,
    getPortEndpoint,
    /** Deprecated upstream, still required — the same endpoint with its headers dropped. */
    getPortUrl: async endpointOptions => (await getPortEndpoint(endpointOptions)).url,
    stop: destroy,
    destroy,
    // `setNetworkPolicy`, `setPorts`, `setRequestTransformations` and
    // `addRequestTransformations` are omitted, the way the harness's own just-bash provider
    // omits them: the contract has no primitive to answer any of them with. The consequence
    // is not cosmetic — an adapter calls `addRequestTransformations?.()` and falls back to
    // legacy credential forwarding when it is absent, so a session here gets that fallback.
    restricted: () => restricted,
  } satisfies HarnessV1NetworkSandboxSession
}
