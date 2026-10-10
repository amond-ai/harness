import { describe, expect, it } from 'vitest'
import { decodeCursor, encodeCursor, isProcessId, journalPaths, parseJournalMeta, replayPositioned } from './index'

describe('@amond-ai/sandbox/journal', () => {
  it('lays a process out under the root and rejects an id that would escape it', () => {
    expect(journalPaths('/tmp/j/', 'p1').stdout).toBe('/tmp/j/p1.out')
    expect(isProcessId('../x')).toBe(false)
    expect(() => journalPaths('/tmp/j', '../x')).toThrow('invalid process id')
  })

  it('trims every trailing slash from the root and keeps an interior one', () => {
    expect(journalPaths('/tmp/j///', 'p1').stderr).toBe('/tmp/j/p1.err')
    expect(journalPaths('/tmp//j', 'p1').exit).toBe('/tmp//j/p1.exit')
  })

  it('round-trips a cursor and reads a malformed one as the start', () => {
    expect(decodeCursor(encodeCursor(3, 7))).toEqual({ stdout: 3, stderr: 7 })
    expect(decodeCursor('nope')).toEqual({ stdout: 0, stderr: 0 })
  })

  it('refuses a meta whose id journalPaths would refuse, so a listing cannot throw on it', () => {
    expect(parseJournalMeta('{"id":"../x","pid":1,"command":["claude"],"startedAt":"t"}')).toBeUndefined()
    expect(parseJournalMeta('{"id":"run-1","pid":1,"command":["claude"],"startedAt":"t"}'))
      .toEqual({ id: 'run-1', pid: 1, command: ['claude'], startedAt: 't' })
  })

  it('advances stderr\'s cursor only on the stderr event, so stopping after stdout misses nothing', () => {
    const bytes = (text: string) => new TextEncoder().encode(text)
    const events = replayPositioned({
      stdout: { data: bytes('ab'), total: 5 },
      stderr: { data: bytes('xyz'), total: 10 },
    }, 'at')

    expect(events.map(event => [event.type, event.cursor])).toEqual([['stdout', '5:7'], ['stderr', '5:10']])
  })
})
