import type {
  SandboxPortEndpoint,
  SandboxPortEndpointOptions,
  SandboxProvider,
  SandboxSession,
} from '@amond-ai/sandbox'
import type { Sandbox as SandboxDO } from '@cloudflare/sandbox'
import { sandboxRoutedUrl } from '@amond-ai/harness-transport-cloudflare'
import { openSandbox } from '@amond-ai/harness-transport-cloudflare/sandbox'

export function createCloudflareProvider(
  namespace: DurableObjectNamespace<SandboxDO>,
): SandboxProvider {
  return {
    backend: 'cloudflare',
    session: (sandboxId: string): SandboxSession => openSandbox(namespace, sandboxId),
    portEndpoint: async (
      sandboxId: string,
      port: number,
      options?: SandboxPortEndpointOptions,
    ): Promise<SandboxPortEndpoint> => ({ url: sandboxRoutedUrl(sandboxId, port, options?.protocol) }),
  } satisfies SandboxProvider
}
