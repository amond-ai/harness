import { describe, expect, it } from 'vitest'
import { parseTurnDriver } from './turn-driver-kind'

describe('parseTurnDriver', () => {
  it('defaults to the sdk driver when unset, since the parity gate passed', () => {
    expect(parseTurnDriver(undefined)).toBe('sdk')
    expect(parseTurnDriver('')).toBe('sdk')
    expect(parseTurnDriver('   ')).toBe('sdk')
  })

  it('selects a driver by name', () => {
    expect(parseTurnDriver('cli')).toBe('cli')
    expect(parseTurnDriver('sdk')).toBe('sdk')
  })

  it('rejects an unknown driver rather than silently falling back', () => {
    expect(() => parseTurnDriver('SDK')).toThrow(/unknown turn driver/)
    expect(() => parseTurnDriver('agent-sdk')).toThrow(/unknown turn driver/)
  })
})
