import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, isProcessId, journalPaths } from './index'

describe('@amond-ai/sandbox/journal', () => {
  it('lays a process out under the root and rejects an id that would escape it', () => {
    expect(journalPaths('/tmp/j/', 'p1').stdout).toBe('/tmp/j/p1.out')
    expect(isProcessId('../x')).toBe(false)
    expect(() => journalPaths('/tmp/j', '../x')).toThrow('invalid process id')
  })

  it('round-trips a cursor and reads a malformed one as the start', () => {
    expect(decodeCursor(encodeCursor(3, 7))).toEqual({ stdout: 3, stderr: 7 })
    expect(decodeCursor('nope')).toEqual({ stdout: 0, stderr: 0 })
  })
})
