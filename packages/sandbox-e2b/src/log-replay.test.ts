import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor } from './log-replay'

describe('cursor', () => {
  it('round-trips the two stream offsets it encodes', () => {
    expect(decodeCursor(encodeCursor(12, 34))).toEqual({ stdout: 12, stderr: 34 })
  })

  it('reads an absent cursor as the start of both streams', () => {
    expect(decodeCursor(undefined)).toEqual({ stdout: 0, stderr: 0 })
  })

  it('reads an unparseable cursor as the start, so a replay is never silently empty', () => {
    expect(decodeCursor('garbage')).toEqual({ stdout: 0, stderr: 0 })
    expect(decodeCursor('1:')).toEqual({ stdout: 0, stderr: 0 })
    expect(decodeCursor('-1:2')).toEqual({ stdout: 0, stderr: 0 })
  })

  it('reads a cursor too large to be represented exactly as one it cannot make sense of', () => {
    // Well-formed is not the same as representable: this matches the pattern and becomes
    // `Infinity`, and a positioned read from `Infinity` drops the whole transcript instead of
    // reading it from the start (cubic review, PR #260).
    expect(decodeCursor(`${'9'.repeat(400)}:0`)).toEqual({ stdout: 0, stderr: 0 })
    expect(decodeCursor(`0:${'9'.repeat(400)}`)).toEqual({ stdout: 0, stderr: 0 })
  })
})
