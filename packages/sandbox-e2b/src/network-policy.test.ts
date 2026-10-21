import type { E2bNetworkUpdate } from './e2b-surface'
import { SandboxCapabilityUnsupportedError } from '@amond-ai/sandbox'
import { describe, expect, it } from 'vitest'
import { fakeSandbox } from './e2b-session.fixtures'
import { applyE2bNetworkUpdate, toE2bNetworkUpdate } from './network-policy'

describe('toE2bNetworkUpdate', () => {
  it('maps the presets onto internet access', () => {
    expect(toE2bNetworkUpdate({ mode: 'allow-all' })).toEqual({ allowInternetAccess: true })
    expect(toE2bNetworkUpdate({ mode: 'deny-all' })).toEqual({ allowInternetAccess: false })
  })

  /**
   * e2b's allow list wins over its deny list, so the allow list only restricts anything when
   * everything else is denied — an allow list on its own would leave all traffic open.
   */
  it('pairs a custom allow list with a deny list covering all traffic', () => {
    expect(toE2bNetworkUpdate({
      mode: 'custom',
      allowedHosts: ['api.anthropic.com'],
      allowedCIDRs: ['10.0.0.0/8'],
    })).toEqual({ allowOut: ['api.anthropic.com', '10.0.0.0/8'], denyOut: ['0.0.0.0/0'] })
  })

  it('accepts an empty deny list as no deny list', () => {
    expect(toE2bNetworkUpdate({ mode: 'custom', allowedCIDRs: ['10.0.0.0/8'], deniedCIDRs: [] }))
      .toEqual({ allowOut: ['10.0.0.0/8'], denyOut: ['0.0.0.0/0'] })
  })

  it('refuses denied ranges, which e2b would leave reachable', () => {
    expect(() => toE2bNetworkUpdate({
      mode: 'custom',
      allowedHosts: ['api.anthropic.com'],
      deniedCIDRs: ['169.254.169.254/32'],
    })).toThrow(SandboxCapabilityUnsupportedError)
  })
})

describe('applyE2bNetworkUpdate', () => {
  function sandboxWith(network: { egressProxy?: unknown, rules?: Record<string, unknown> }) {
    const updates: E2bNetworkUpdate[] = []
    const sandbox = {
      ...fakeSandbox().sandbox,
      getInfo: async () => ({ network }),
      updateNetwork: async (update: E2bNetworkUpdate) => {
        updates.push(update)
      },
    }
    return { sandbox, updates }
  }

  it('applies the update to a sandbox with nothing it would clear', async () => {
    const { sandbox, updates } = sandboxWith({ rules: {} })
    await applyE2bNetworkUpdate(sandbox, { allowInternetAccess: false })

    expect(updates).toEqual([{ allowInternetAccess: false }])
  })

  /** The update replaces the whole configuration, and e2b never returns a proxy's password. */
  it.each([
    ['an egress proxy', { egressProxy: { address: 'proxy.example.com:1080' } }],
    ['per-host transform rules', { rules: { 'api.example.com': [{}] } }],
  ])('refuses rather than dropping %s', async (_, network) => {
    const { sandbox, updates } = sandboxWith(network)

    await expect(applyE2bNetworkUpdate(sandbox, { allowInternetAccess: true }))
      .rejects
      .toBeInstanceOf(SandboxCapabilityUnsupportedError)
    expect(updates).toEqual([])
  })
})
