import { describe, expect, it } from 'vitest'
import { quoteArg, quoteArgv, unquoteArgv } from './shell-quote'

describe('quoteArgv', () => {
  it('leaves nothing for the shell to interpret', () => {
    expect(quoteArg('$(rm -rf /)')).toBe(`'$(rm -rf /)'`)
    expect(quoteArg('a b\nc')).toBe(`'a b\nc'`)
  })

  it('closes and reopens around a quote', () => {
    expect(quoteArg(`it's`)).toBe(`'it'\\''s'`)
  })

  it('refuses an empty argv rather than emitting nothing', () => {
    // Handed to `sh -c`, an empty word list runs the redirection alone and reports success:
    // a command that never ran, recorded as one that ran fine.
    expect(() => quoteArgv([])).toThrow(/no command to run/)
  })
})

describe('unquoteArgv', () => {
  it('round-trips what quoteArgv emits', () => {
    for (const argv of [
      ['claude', '-p'],
      ['sh', '-c', `printf "x'y"`],
      ['echo', ''],
      ['echo', 'a b', 'c\nd', `it's`, 'back\\slash'],
    ]) {
      expect(unquoteArgv(quoteArgv(argv))).toEqual(argv)
    }
  })

  it('answers undefined for anything it did not emit', () => {
    for (const line of ['claude -p', `'unterminated`, '', `'a'b`]) {
      expect(unquoteArgv(line)).toBeUndefined()
    }
  })
})
