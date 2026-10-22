import type {
  SandboxPortEndpoint,
  SandboxPortEndpointOptions,
  SandboxProvider,
  SandboxSession,
} from '@amond-ai/sandbox'
import type { HarnessSandbox } from './durable-object'
import type { HarnessSandboxRpc } from './rpc'
import { sandboxRoutedUrl } from '@amond-ai/harness-transport-cloudflare'
import { openSandbox } from '@amond-ai/harness-transport-cloudflare/sandbox'
import { createCloudflareSession } from './session'

/** The Cloudflare backend, over a namespace bound to {@link HarnessSandbox}. */
export function createCloudflareProvider(
  namespace: DurableObjectNamespace<HarnessSandbox>,
): SandboxProvider {
  return {
    backend: 'cloudflare',
    session: (sandboxId: string): SandboxSession =>
      // Cast because Workers' RPC typing widens the `SandboxCommand` tuple to `readonly string[]`
      // and marks each result disposable; the values that arrive are the ones
      // `HarnessSandboxRpc` names, which `HarnessSandbox` implements.
      createCloudflareSession(openSandbox(namespace, sandboxId) as unknown as HarnessSandboxRpc),
    portEndpoint: async (
      sandboxId: string,
      port: number,
      options?: SandboxPortEndpointOptions,
    ): Promise<SandboxPortEndpoint> => ({ url: sandboxRoutedUrl(sandboxId, port, options?.protocol) }),
  } satisfies SandboxProvider
}
