/**
 * Kept out of the package root because `@cloudflare/sandbox` imports `cloudflare:workers`,
 * which resolves only inside a Worker build.
 */
import type { Sandbox } from '@cloudflare/sandbox'
import { getSandbox } from '@cloudflare/sandbox'
import { SANDBOX_OPTIONS } from './ws-compat'

export function openSandbox(
  namespace: DurableObjectNamespace<Sandbox>,
  sandboxId: string,
): ReturnType<typeof getSandbox<Sandbox>> {
  return getSandbox(namespace, sandboxId, SANDBOX_OPTIONS)
}
