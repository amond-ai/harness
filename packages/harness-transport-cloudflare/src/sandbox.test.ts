import type { Sandbox } from '@cloudflare/sandbox'
import { getSandbox } from '@cloudflare/sandbox'
import { describe, expect, it, vi } from 'vitest'
import { openSandbox } from './sandbox'
import { SANDBOX_OPTIONS } from './ws-compat'

vi.mock('@cloudflare/sandbox', () => ({ getSandbox: vi.fn() }))

describe('openSandbox', () => {
  it('opens the sandbox with the shared options and returns the client unchanged', () => {
    const namespace = {} as DurableObjectNamespace<Sandbox>
    const client = {}
    vi.mocked(getSandbox).mockReturnValue(client as never)

    expect(openSandbox(namespace, 'run-1')).toBe(client)
    expect(getSandbox).toHaveBeenCalledWith(namespace, 'run-1', SANDBOX_OPTIONS)
  })
})
