import type { SandboxSession } from '@amond-ai/sandbox'
import type { Sandbox as SandboxDO } from '@cloudflare/sandbox'
import { createHarnessSandboxProvider } from '@amond-ai/harness-sandbox'
import { SANDBOX_ID_PARAM, SANDBOX_OPTIONS } from '@amond-ai/harness-transport-cloudflare'
import { getSandbox } from '@cloudflare/sandbox'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createCloudflareProvider } from './provider'

// The real module imports `cloudflare:workers`, which resolves only inside a Worker build.
vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }))

const namespace = {} as DurableObjectNamespace<SandboxDO>

function fakeClient(): SandboxSession {
  return { destroy: vi.fn(async () => {}) } as unknown as SandboxSession
}

beforeEach(() => {
  vi.mocked(getSandbox).mockReset()
})

describe('createCloudflareProvider', () => {
  it('returns the client getSandbox hands back, unchanged', () => {
    const client = fakeClient()
    vi.mocked(getSandbox).mockReturnValue(client as never)

    const session = createCloudflareProvider(namespace).session('run-1')

    expect(session).toBe(client)
    expect(getSandbox).toHaveBeenCalledWith(namespace, 'run-1', SANDBOX_OPTIONS)
  })

  it('tags a port endpoint for the transport instead of resolving an address', async () => {
    const endpoint = await createCloudflareProvider(namespace)
      .portEndpoint('run-1', 3000, { protocol: 'ws' })

    const url = new URL(endpoint.url)
    expect(url.protocol).toBe('ws:')
    expect(url.hostname).toBe('localhost')
    expect(url.port).toBe('3000')
    expect(url.searchParams.get(SANDBOX_ID_PARAM)).toBe('run-1')
    expect(endpoint.headers).toBeUndefined()
    expect(getSandbox).not.toHaveBeenCalled()
  })

  it('defaults a port endpoint to http', async () => {
    const endpoint = await createCloudflareProvider(namespace).portEndpoint('run-1', 8080)

    expect(new URL(endpoint.url).protocol).toBe('http:')
  })
})

describe('createHarnessSandboxProvider over the Cloudflare backend', () => {
  it('opens a harness session on the sandbox the id names', async () => {
    const client = fakeClient()
    vi.mocked(getSandbox).mockReturnValue(client as never)

    const harness = createHarnessSandboxProvider({
      sandboxes: createCloudflareProvider(namespace),
      defaultWorkingDirectory: '/workspace',
      ports: [3000],
    })
    const session = await harness.createSession({ sessionId: 'run-1' })

    expect(harness.providerId).toBe('pleaseai-cloudflare')
    expect(session.id).toBe('run-1')
    expect(getSandbox).toHaveBeenCalledWith(namespace, 'run-1', SANDBOX_OPTIONS)

    const endpoint = await session.getPortEndpoint({ port: 3000, protocol: 'ws' })
    expect(new URL(endpoint.url).searchParams.get(SANDBOX_ID_PARAM)).toBe('run-1')

    await session.destroy()
    expect(client.destroy).toHaveBeenCalledOnce()
  })
})
