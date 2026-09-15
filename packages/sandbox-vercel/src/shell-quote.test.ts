import { describe, expect, it } from 'vitest'
import { quoteArg, quoteArgv, unquoteArgv } from './shell-quote'

describe('quoteArg', () => {
  it('wraps a plain word so the shell cannot reinterpret it', () => {
    expect(quoteArg('claude')).toBe(`'claude'`)
  })

  it('keeps a spaced argument as one word', () => {
    expect(quoteArg('two words')).toBe(`'two words'`)
  })

  it('quotes an empty argument rather than dropping it', () => {
    expect(quoteArg('')).toBe(`''`)
  })

  it('escapes a single quote by closing, escaping and reopening', () => {
    expect(quoteArg(`it's`)).toBe(`'it'\\''s'`)
  })

  it('neutralises command substitution, variables and separators', () => {
    expect(quoteArg('$HOME `id` && rm -rf /; echo x')).toBe(`'$HOME \`id\` && rm -rf /; echo x'`)
  })

  it('keeps a newline inside the quoted word', () => {
    expect(quoteArg('line one\nline two')).toBe(`'line one\nline two'`)
  })
})

describe('quoteArgv', () => {
  it('joins an argv into one shell word list', () => {
    expect(quoteArgv(['claude', '-p', 'do the thing'])).toBe(`'claude' '-p' 'do the thing'`)
  })

  it('survives a prompt carrying quotes and shell metacharacters', () => {
    const argv = ['claude', '-p', `fix "quotes" && rm -rf $HOME; it's fine`]
    expect(quoteArgv(argv)).toBe(
      `'claude' '-p' 'fix "quotes" && rm -rf $HOME; it'\\''s fine'`,
    )
  })

  it('refuses an empty argv, which would run the wrong command silently', () => {
    expect(() => quoteArgv([])).toThrow()
  })
})

describe('unquoteArgv', () => {
  it('round-trips whatever quoteArgv produced, attacker-influenced text included', () => {
    // The recovery path exists for a turn whose journal meta is missing, and that turn is
    // exactly the one whose argv carries text chosen to break a parser.
    const argv = ['claude', '-p', `it's "quoted" ; } > /etc/passwd`, 'multi\nline', '$HOME `id`']
    expect(unquoteArgv(quoteArgv(argv))).toEqual(argv)
  })

  it('round-trips an argument that is nothing but a quote', () => {
    expect(unquoteArgv(quoteArg(`'`))).toEqual([`'`])
  })

  it('round-trips an empty argument rather than dropping it', () => {
    expect(unquoteArgv(quoteArgv(['claude', '']))).toEqual(['claude', ''])
  })

  it('returns undefined for bare text, which quoteArg never emits', () => {
    // Reading `claude -p hi` as an argv would invent one nobody ran, and bare text is what
    // arrives when the string did not come from this module at all.
    expect(unquoteArgv('claude -p hi')).toBeUndefined()
  })

  it('returns undefined for an unterminated quote', () => {
    expect(unquoteArgv(`'claude' '-p`)).toBeUndefined()
  })

  it('returns undefined for an empty string, which is no argv at all', () => {
    expect(unquoteArgv('')).toBeUndefined()
  })
})
