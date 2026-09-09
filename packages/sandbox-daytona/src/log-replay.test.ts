import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, replayPositioned, sliceFrom } from './log-replay'

const AT = '2026-09-09T13:00:00.000Z'
const decode = (data: Uint8Array): string => new TextDecoder().decode(data)

describe('the log cursor', () => {
  it('round-trips a pair of byte offsets', () => {
    expect(decodeCursor(encodeCursor(12, 34))).toEqual({ stdout: 12, stderr: 34 })
  })

  /**
   * An unreadable cursor reads as the start rather than rejecting: a replay that silently
   * returned nothing would present as a wedged turn (AC-026).
   */
  it('reads an absent or unparseable cursor as the beginning', () => {
    expect(decodeCursor(undefined)).toEqual({ stdout: 0, stderr: 0 })
    expect(decodeCursor('nonsense')).toEqual({ stdout: 0, stderr: 0 })
    // Well-formed is not the same as representable: this matches the pattern and becomes
    // `Infinity`, which would drop the whole transcript rather than replay it.
    expect(decodeCursor(`${'9'.repeat(400)}:0`)).toEqual({ stdout: 0, stderr: 0 })
  })
})

describe('sliceFrom', () => {
  it('reports the full byte length whatever it served', () => {
    expect(sliceFrom('hello', 3)).toEqual({ data: new TextEncoder().encode('lo'), total: 5 })
  })

  /**
   * The reason the cursor counts bytes rather than code units. Daytona hands back a *string*, but
   * one Korean syllable is three bytes and one code unit, so a cursor counted in code units would
   * drift the moment a turn printed a non-ASCII character — and the drift would surface as a
   * truncated NDJSON line, not as an error.
   */
  it('positions in bytes, so a multi-byte character does not desynchronise the cursor', () => {
    const text = '가나'
    expect(sliceFrom(text, 0).total).toBe(6)
    expect(decode(sliceFrom(text, 3).data)).toBe('나')
  })

  /** An offset landing inside a character resumes mid-character rather than re-serving bytes. */
  it('resumes mid-character rather than duplicating bytes already delivered', () => {
    const slice = sliceFrom('가', 1)
    expect([...slice.data]).toEqual([...new TextEncoder().encode('가')].slice(1))
    expect(slice.total).toBe(3)
  })

  it('answers with nothing for a cursor at or past the end, which an idle turn produces', () => {
    expect(sliceFrom('hi', 2).data.length).toBe(0)
    expect(sliceFrom('hi', 99)).toEqual({ data: new Uint8Array(), total: 2 })
    expect(sliceFrom(undefined, 0)).toEqual({ data: new Uint8Array(), total: 0 })
  })
})

describe('replayPositioned', () => {
  it('tags each stream and carries the full lengths in the cursor, not what it served', () => {
    const events = replayPositioned({ stdout: sliceFrom('abcd', 2), stderr: sliceFrom('xy', 0) }, AT)

    expect(events.map(event => event.type)).toEqual(['stdout', 'stderr'])
    expect(events.every(event => event.cursor === encodeCursor(4, 2))).toBe(true)
    expect(events.map(event => 'data' in event ? decode(event.data) : '')).toEqual(['cd', 'xy'])
  })

  /** A sample that found nothing new emits nothing, rather than an empty event per stream. */
  it('emits nothing for a stream that has not grown', () => {
    expect(replayPositioned({ stdout: sliceFrom('ab', 2), stderr: sliceFrom('', 0) }, AT)).toEqual([])
  })

  /**
   * No terminal event: a positioned read is the watchdog sampling liveness, and re-serving the
   * exit on every tick would double-count it.
   */
  it('never terminates a positioned read', () => {
    const events = replayPositioned({ stdout: sliceFrom('a', 0), stderr: sliceFrom('b', 0) }, AT)
    expect(events.some(event => event.type === 'terminal')).toBe(false)
  })
})
