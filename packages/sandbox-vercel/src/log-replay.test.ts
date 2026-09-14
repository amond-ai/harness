import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, replayPositioned } from './log-replay'

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
    // reading it from the start.
    expect(decodeCursor(`${'9'.repeat(400)}:0`)).toEqual({ stdout: 0, stderr: 0 })
    expect(decodeCursor(`0:${'9'.repeat(400)}`)).toEqual({ stdout: 0, stderr: 0 })
  })
})

describe('replayPositioned', () => {
  const at = '2026-09-14T13:00:00.000Z'

  it('tags each stream separately and carries the files\' full lengths in the cursor', () => {
    // The cursor is a position in the journal, so it encodes `total` — never `data.length`,
    // which is only the part that arrived after the caller's last read.
    const events = replayPositioned({
      stdout: { data: new TextEncoder().encode('out'), total: 10 },
      stderr: { data: new TextEncoder().encode('err'), total: 20 },
    }, at)

    expect(events).toEqual([
      { type: 'stdout', cursor: '10:20', timestamp: at, data: new TextEncoder().encode('out') },
      { type: 'stderr', cursor: '10:20', timestamp: at, data: new TextEncoder().encode('err') },
    ])
  })

  it('emits nothing for a stream that has not grown, and no terminal event either', () => {
    // A positioned read is the watchdog sampling liveness: it counts bytes and ignores terminal
    // events, so re-serving an exit on every tick would be a double-counted one.
    expect(replayPositioned({
      stdout: { data: new Uint8Array(), total: 7 },
      stderr: { data: new Uint8Array(), total: 0 },
    }, at)).toEqual([])
  })
})
