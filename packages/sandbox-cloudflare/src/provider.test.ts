import type { HarnessSandbox } from './durable-object'
import { createHarnessSandboxProvider } from '@amond-ai/harness-sandbox'
import { SANDBOX_ID_PARAM } from '@amond-ai/harness-transport-cloudflare'
import { describe, expect, it, vi } from 'vitest'
import { createCloudflareProvider } from './provider'

function fakeNamespace() {
  const destroySandbox = vi.fn(async () => {})
  const exists = vi.fn(async () => true)
  const getByName = vi.fn(() => ({ destroySandbox, exists }))
  const namespace = { getByName } as unknown as DurableObjectNamespace<HarnessSandbox>
  return { namespace, getByName, destroySandbox, exists }
}

describe('createCloudflareProvider', () => {
  it('resolves a session synchronously on the object the lowercased id names', async () => {
    const { namespace, getByName, exists } = fakeNamespace()

    const session = createCloudflareProvider(namespace).session('Run-1')

    expect(getByName).toHaveBeenCalledWith('run-1')
    expect(await session.exists('/workspace')).toEqual({ exists: true })
    expect(exists).toHaveBeenCalledWith('/workspace')
  })

  it('tags a port endpoint for the transport instead of resolving an address', async () => {
    const { namespace, getByName } = fakeNamespace()
    const endpoint = await createCloudflareProvider(namespace)
      .portEndpoint('run-1', 3000, { protocol: 'ws' })

    const url = new URL(endpoint.url)
    expect(url.protocol).toBe('ws:')
    expect(url.hostname).toBe('localhost')
    expect(url.port).toBe('3000')
    expect(url.searchParams.get(SANDBOX_ID_PARAM)).toBe('run-1')
    expect(endpoint.headers).toBeUndefined()
    expect(getByName).not.toHaveBeenCalled()
  })

  it('defaults a port endpoint to http', async () => {
    const { namespace } = fakeNamespace()
    const endpoint = await createCloudflareProvider(namespace).portEndpoint('run-1', 8080)

    expect(new URL(endpoint.url).protocol).toBe('http:')
  })
})

describe('createHarnessSandboxProvider over the Cloudflare backend', () => {
  it('opens a harness session on the sandbox the id names', async () => {
    const { namespace, getByName, destroySandbox } = fakeNamespace()

    const harness = createHarnessSandboxProvider({
      sandboxes: createCloudflareProvider(namespace),
      defaultWorkingDirectory: '/workspace',
      ports: [3000],
    })
    const session = await harness.createSession({ sessionId: 'run-1' })

    expect(harness.providerId).toBe('pleaseai-cloudflare')
    expect(session.id).toBe('run-1')
    expect(getByName).toHaveBeenCalledWith('run-1')

    const endpoint = await session.getPortEndpoint({ port: 3000, protocol: 'ws' })
    expect(new URL(endpoint.url).searchParams.get(SANDBOX_ID_PARAM)).toBe('run-1')

    await session.destroy()
    expect(destroySandbox).toHaveBeenCalledOnce()
  })
})
