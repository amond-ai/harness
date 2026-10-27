import { describe, expect, it } from 'vitest'
import { quoteArg, quoteArgv, unquoteArgv, unquoteFirstArg } from './shell-quote'

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

  // The one character single quoting cannot contain: closed, escaped, reopened.
  it('escapes a single quote by closing, escaping and reopening', () => {
    expect(quoteArg(`it's`)).toBe(`'it'\\''s'`)
  })

  it('neutralises command substitution, variables and separators', () => {
    expect(quoteArg('$HOME `id` && rm -rf /; echo x')).toBe(`'$HOME \`id\` && rm -rf /; echo x'`)
  })

  it('keeps a newline inside the quoted word', () => {
    expect(quoteArg('line one\nline two')).toBe(`'line one\nline two'`)
  })

  it('leaves nothing for the shell to interpret', () => {
    expect(quoteArg('$(rm -rf /)')).toBe(`'$(rm -rf /)'`)
    expect(quoteArg('a b\nc')).toBe(`'a b\nc'`)
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

  it('refuses a NUL byte, naming what carries it', () => {
    // There is no shell spelling for one, and quoted through it lands in a script the runtime
    // or SDK rejects with an error about the script — nothing pointing at the argument. The
    // boundary that knows which one says so.
    expect(() => quoteArg('/tmp/na\0me')).toThrow(/an argument containing a NUL byte/)
    expect(() => quoteArg('/tmp/na\0me', 'the pid journal path')).toThrow(/the pid journal path containing a NUL byte/)
  })
})

describe('quoteArgv', () => {
  it('joins an argv into one shell word list', () => {
    expect(quoteArgv(['claude', '-p', 'do the thing'])).toBe(`'claude' '-p' 'do the thing'`)
    expect(quoteArgv(['claude', '-p', 'fix the bug'])).toBe(`'claude' '-p' 'fix the bug'`)
  })

  it('survives a prompt carrying quotes and shell metacharacters', () => {
    const argv = ['claude', '-p', `fix "quotes" && rm -rf $HOME; it's fine`]
    expect(quoteArgv(argv)).toBe(
      `'claude' '-p' 'fix "quotes" && rm -rf $HOME; it'\\''s fine'`,
    )
  })

  /**
   * Handed to `sh -c`, an empty word list would run the wrapper's bookkeeping alone and report
   * success — the silent-success failure mode, dressed as a completed turn.
   */
  it('refuses an empty argv rather than producing a command that runs something else', () => {
    expect(() => quoteArgv([])).toThrow(/empty argv/)
    expect(() => quoteArgv([])).toThrow(/no command to run/)
  })

  it('refuses a NUL byte, naming the element that carries it', () => {
    expect(() => quoteArgv(['claude', '-p', 'hello\0world'])).toThrow(/argv\[2\].*NUL byte/)
  })
})

describe('unquoteArgv', () => {
  it('round-trips whatever quoteArgv produced, attacker-influenced text included', () => {
    // The recovery path exists for a turn whose journal meta is missing, and that turn is
    // exactly the one whose argv carries text chosen to break a parser.
    const argv = ['claude', '-p', `it's "quoted" ; } > /etc/passwd`, 'multi\nline', '$HOME `id`']
    expect(unquoteArgv(quoteArgv(argv))).toEqual(argv)
  })

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

  it('answers undefined for anything it did not emit', () => {
    for (const line of ['claude -p', `'unterminated`, '', `'a'b`]) {
      expect(unquoteArgv(line)).toBeUndefined()
    }
  })

  it('returns undefined for an escaped quote that does not reopen the quoting', () => {
    expect(unquoteArgv(`'a'\\'`)).toBeUndefined()
  })
})

describe('unquoteFirstArg', () => {
  it('reads one quoted word and says where it ends', () => {
    const line = `${quoteArg(`/home/user/.agent-runs/run-1.out`)} 2> ${quoteArg(`/x.err`)}`
    const first = unquoteFirstArg(line)
    expect(first?.value).toBe(`/home/user/.agent-runs/run-1.out`)
    expect(line.slice(first?.end ?? 0)).toBe(` 2> ${quoteArg(`/x.err`)}`)
  })

  it('reassembles a word whose quoting was split around an embedded quote', () => {
    // `quoteArg` emits `'it'\''s'` for `it's` — four segments, not one. Reading only the
    // first would truncate the path and lose the process it names.
    expect(unquoteFirstArg(`${quoteArg(`/it's/run-1.out`)} rest`)?.value).toBe(`/it's/run-1.out`)
  })

  it('returns undefined for bare text, which is not something quoteArg wrote', () => {
    expect(unquoteFirstArg(`/home/user/run-1.out`)).toBeUndefined()
  })

  it('returns undefined for an unterminated quote', () => {
    expect(unquoteFirstArg(`'/home/user/run-1.out`)).toBeUndefined()
  })
})
