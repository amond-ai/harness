/**
 * A harness network policy, applied to a running e2b sandbox.
 *
 * Two of e2b's rules decide what can be applied exactly, and anything that cannot is refused
 * with {@link SandboxCapabilityUnsupportedError} rather than approximated:
 *
 * - **Allow beats deny.** e2b gives `allowOut` precedence over `denyOut`, the opposite of the
 *   policy's own rule that `deniedCIDRs` wins. An allow list is therefore paired with a deny
 *   list covering all traffic, and a policy that names `deniedCIDRs` cannot be expressed: the
 *   denied range would stay reachable through whatever allowed it.
 * - **An update replaces everything.** `updateNetwork` clears each field it is not given, and
 *   e2b never returns an egress proxy's password, so a proxy cannot be carried over. A sandbox
 *   with a proxy or per-host rules is refused instead of quietly losing them.
 */
import type { SandboxNetworkPolicy } from '@amond-ai/sandbox'
import type { E2bNetworkUpdate, E2bSandboxLike } from './e2b-surface'
import { SandboxCapabilityUnsupportedError } from '@amond-ai/sandbox'

const ALL_TRAFFIC = '0.0.0.0/0'
const BACKEND = 'e2b'

export function toE2bNetworkUpdate(policy: SandboxNetworkPolicy): E2bNetworkUpdate {
  switch (policy.mode) {
    case 'allow-all':
      return { allowInternetAccess: true }
    case 'deny-all':
      return { allowInternetAccess: false }
    case 'custom':
      if ((policy.deniedCIDRs?.length ?? 0) > 0) {
        throw new SandboxCapabilityUnsupportedError(
          BACKEND,
          'e2b cannot apply deniedCIDRs: its allow list takes precedence over its deny list, '
          + 'so a denied range would stay reachable through the allowed hosts and ranges.',
        )
      }
      return {
        allowOut: [...(policy.allowedHosts ?? []), ...(policy.allowedCIDRs ?? [])],
        denyOut: [ALL_TRAFFIC],
      }
  }
}

export async function applyE2bNetworkUpdate(
  sandbox: E2bSandboxLike,
  update: E2bNetworkUpdate,
): Promise<void> {
  const { network } = await sandbox.getInfo()
  if (network?.egressProxy != null) {
    throw dropsConfiguration('an egress proxy')
  }
  if (Object.keys(network?.rules ?? {}).length > 0) {
    throw dropsConfiguration('per-host transform rules')
  }
  await sandbox.updateNetwork(update)
}

function dropsConfiguration(configuration: string): SandboxCapabilityUnsupportedError {
  return new SandboxCapabilityUnsupportedError(
    BACKEND,
    `e2b replaces the whole egress configuration when the network policy changes, which would `
    + `drop ${configuration} from this sandbox. Change it with the native sandbox.updateNetwork() instead.`,
  )
}
