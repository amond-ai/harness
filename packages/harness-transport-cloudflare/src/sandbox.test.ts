import { describe, expect, it, vi } from 'vitest'
import { openSandbox } from './sandbox'

describe('openSandbox', () => {
  it('opens the object named by the lowercased id and returns its stub unchanged', () => {
    const stub = {}
    const getByName = vi.fn(() => stub)
    const namespace = { getByName } as unknown as DurableObjectNamespace

    expect(openSandbox(namespace, 'Run-1')).toBe(stub)
    expect(getByName).toHaveBeenCalledWith('run-1')
  })
})
