import { describe, expect, it } from 'vitest'
import { quoteArg, quoteArgv } from './shell-quote'

describe('quoteArg', () => {
  it('wraps a word so the shell reads it literally', () => {
    expect(quoteArg('claude')).toBe(`'claude'`)
  })

  // The one character single quoting cannot contain: closed, escaped, reopened.
  it('survives a single quote by closing and reopening the quoting', () => {
    expect(quoteArg(`it's`)).toBe(`'it'\\''s'`)
  })

  /**
   * The argument this exists for. An issue title reaches `claude -p` as one argv element and is
   * attacker-influenced text, so every shell metacharacter has to arrive as data.
   */
  it('leaves shell metacharacters as data', () => {
    for (const hostile of ['$(rm -rf /)', '`id`', 'a; b', 'a && b', 'a\nb', '$HOME', 'a|b', '*']) {
      expect(quoteArg(hostile)).toBe(`'${hostile}'`)
    }
  })
})

describe('quoteArgv', () => {
  it('joins a whole argv into one word list', () => {
    expect(quoteArgv(['claude', '-p', 'fix the bug'])).toBe(`'claude' '-p' 'fix the bug'`)
  })

  /**
   * Handed to `sh -c`, an empty word list would run the pid-recording prefix alone and report
   * success — the silent-success failure mode, dressed as a completed turn.
   */
  it('refuses an empty argv rather than producing a command that runs something else', () => {
    expect(() => quoteArgv([])).toThrow(/empty argv/)
  })
})
