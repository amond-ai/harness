import type {
  SandboxPortEndpoint,
  SandboxPortEndpointOptions,
  SandboxProvider,
  SandboxSession,
} from '@amond-ai/sandbox'
import type { Sandbox as SandboxDO } from '@cloudflare/sandbox'
import { SANDBOX_ID_PARAM } from '@amond-ai/harness-transport-cloudflare'
import { openSandbox } from '@amond-ai/harness-transport-cloudflare/sandbox'

const DEFAULT_PROTOCOL = 'http'

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
    ): Promise<SandboxPortEndpoint> => {
      const url = new URL(`${options?.protocol ?? DEFAULT_PROTOCOL}://localhost:${String(port)}/`)
      url.searchParams.set(SANDBOX_ID_PARAM, sandboxId)
      return { url: url.toString() }
    },
  } satisfies SandboxProvider
}
