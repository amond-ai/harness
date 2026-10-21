import type {
  SandboxPortEndpoint,
  SandboxPortEndpointOptions,
  SandboxProvider,
  SandboxSession,
} from '@amond-ai/sandbox'
import type { Sandbox as SandboxDO } from '@cloudflare/sandbox'
import { SANDBOX_ID_PARAM, SANDBOX_OPTIONS } from '@amond-ai/harness-transport-cloudflare'
import { getSandbox } from '@cloudflare/sandbox'

const DEFAULT_PROTOCOL = 'http'

export function createCloudflareProvider(
  namespace: DurableObjectNamespace<SandboxDO>,
): SandboxProvider {
  return {
    backend: 'cloudflare',
    session: (sandboxId: string): SandboxSession =>
      getSandbox(namespace, sandboxId, SANDBOX_OPTIONS),
    portEndpoint: (
      sandboxId: string,
      port: number,
      options?: SandboxPortEndpointOptions,
    ): Promise<SandboxPortEndpoint> => {
      const url = new URL(`${options?.protocol ?? DEFAULT_PROTOCOL}://localhost:${String(port)}/`)
      url.searchParams.set(SANDBOX_ID_PARAM, sandboxId)
      return Promise.resolve({ url: url.toString() })
    },
  } satisfies SandboxProvider
}
