import { describe, expect, it } from 'bun:test'
import { journalledCommand, journalPaths, parseJournalMeta, serializeJournalMeta } from './journal'

const ROOT = '/home/user/.agent-runs'

describe('journalPaths', () => {
  it('derives the four artefacts of one process from its id', () => {
    expect(journalPaths(ROOT, 'abc123')).toEqual({
      stdout: '/home/user/.agent-runs/abc123.out',
      stderr: '/home/user/.agent-runs/abc123.err',
      exit: '/home/user/.agent-runs/abc123.exit',
      meta: '/home/user/.agent-runs/abc123.meta.json',
    })
  })

  it('tolerates a trailing slash on the root', () => {
    expect(journalPaths('/home/user/.agent-runs/', 'abc123').stdout)
      .toBe('/home/user/.agent-runs/abc123.out')
  })

  it('refuses a process id that would escape the journal root', () => {
    expect(() => journalPaths(ROOT, '../../etc/passwd')).toThrow()
    expect(() => journalPaths(ROOT, 'a/b')).toThrow()
    expect(() => journalPaths(ROOT, '')).toThrow()
  })
})

describe('journalledCommand', () => {
  const paths = journalPaths(ROOT, 'abc123')

  it('runs the argv with both streams and the exit code captured', () => {
    expect(journalledCommand(['echo', 'hi'], paths)).toBe(
      `{ 'echo' 'hi' ; } > '/home/user/.agent-runs/abc123.out'`
      + ` 2> '/home/user/.agent-runs/abc123.err'`
      + ` ; printf '%s' "$?" > '/home/user/.agent-runs/abc123.exit'`,
    )
  })

  it('quotes the argv, so a prompt cannot break out into the wrapper', () => {
    const command = journalledCommand(['claude', '-p', `x'; rm -rf / #`], paths)
    expect(command).toContain(`'x'\\''; rm -rf / #'`)
    // The payload must not survive unescaped anywhere in the wrapper. Quoted, the `x` is
    // followed by `'\''` rather than by `';`, so dropping the escaping is what makes this
    // substring appear.
    expect(command).not.toContain(`x'; rm -rf / #`)
  })

  it('reads `$?` after the redirected group, so a failing command records its code', () => {
    // Asserting the suffix is present proves nothing — it is a constant of the template, so
    // it survives even the regression this guards against. The *order* is the invariant:
    // `$?` read inside the group would be the group's own last command, not the argv's.
    const command = journalledCommand(['false'], paths)

    expect(command.indexOf(' ; } > ')).toBeLessThan(command.indexOf(`printf '%s' "$?"`))
  })
})

describe('journal meta', () => {
  it('round-trips what the backend must remember about a process', () => {
    const meta = {
      id: 'abc123',
      pid: 2054,
      command: ['claude', '-p', 'do it'] as const,
      cwd: '/workspace/repo',
      startedAt: '2026-08-24T13:00:00.000Z',
    }
    expect(parseJournalMeta(serializeJournalMeta(meta))).toEqual(meta)
  })

  it('rejects a meta whose command is empty, which could not have run anything', () => {
    expect(parseJournalMeta('{"id":"a","pid":1,"command":[],"startedAt":"t"}')).toBeUndefined()
  })

  it('rejects a command whose elements are not all strings', () => {
    // `command` is a SandboxCommand — a tuple of strings — and the journal file is written
    // inside the sandbox the agent controls, so the elements are input, not an invariant.
    expect(parseJournalMeta('{"id":"a","pid":1,"command":["claude",5],"startedAt":"t"}'))
      .toBeUndefined()
    expect(parseJournalMeta('{"id":"a","pid":1,"command":[null],"startedAt":"t"}'))
      .toBeUndefined()
  })

  it('returns undefined for content that is not a journal meta', () => {
    expect(parseJournalMeta('not json')).toBeUndefined()
    expect(parseJournalMeta('{"id":"abc"}')).toBeUndefined()
    expect(parseJournalMeta('[]')).toBeUndefined()
  })
})
