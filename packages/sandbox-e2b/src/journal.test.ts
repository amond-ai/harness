import { describe, expect, it } from 'bun:test'
import { journalledCommand, journalledScriptIn, journalPaths, parseJournalMeta, serializeJournalMeta, SESSION_OPEN } from './journal'
import { quoteArg, quoteArgv, unquoteArgv } from './shell-quote'

/**
 * The wrapper the pre-#276 writer emitted, byte for byte.
 *
 * Built with the same `quoteArgv`/`quoteArg` that wrote it rather than hand-escaped: the
 * legacy grammar is the thing under test, and a `'\''` typed by hand would be testing the
 * typing. e2b reports a command as the shell it ran plus its argv, which is why the caller
 * prepends `/bin/bash -l -c `.
 */
function legacyWrapper(argv: readonly string[], paths: { stdout: string, stderr: string, exit: string }): string {
  return `{ ${quoteArgv(argv)} ; } > ${quoteArg(paths.stdout)} 2> ${quoteArg(paths.stderr)}`
    + ` ; printf '%s' "$?" > ${quoteArg(paths.exit)}`
}

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

  it('is exactly the string e2b is asked to run, session prefix and quoting included', () => {
    // The one assertion in this file with no peeling anywhere in it. Every other test reads
    // the wrapper back through `journalledScriptIn`, which is the writer's own inverse: a
    // prefix that was malformed and a peel malformed in the mirror-image way would leave all
    // of them green while the sandbox refuses the command. This is what catches a missing
    // `--wait`, a flag `setsid` does not take, or quoting no shell would accept.
    expect(journalledCommand(['echo', 'hi'], paths)).toBe(
      `setsid --wait sh -c '{ '\\''echo'\\'' '\\''hi'\\'' ; }`
      + ` > '\\''/home/user/.agent-runs/abc123.out'\\''`
      + ` 2> '\\''/home/user/.agent-runs/abc123.err'\\''`
      + ` ; printf '\\''%s'\\'' "$?" > '\\''/home/user/.agent-runs/abc123.exit'\\'''`,
    )
  })

  it('runs the argv with both streams and the exit code captured', () => {
    // Read through the peel: the script is what the wrapper actually executes, and the layer
    // above it is pinned by the literal assertion beside this one.
    expect(journalledScriptIn(journalledCommand(['echo', 'hi'], paths))).toBe(
      `{ 'echo' 'hi' ; } > '/home/user/.agent-runs/abc123.out'`
      + ` 2> '/home/user/.agent-runs/abc123.err'`
      + ` ; printf '%s' "$?" > '/home/user/.agent-runs/abc123.exit'`,
    )
  })

  it('quotes the argv, so a prompt cannot break out into the wrapper', () => {
    const command = journalledScriptIn(journalledCommand(['claude', '-p', `x'; rm -rf / #`], paths))
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
    const command = journalledScriptIn(journalledCommand(['false'], paths))

    expect(command.indexOf(' ; } > ')).toBeLessThan(command.indexOf(`printf '%s' "$?"`))
  })
})

describe('the wrapper\'s own session', () => {
  const paths = journalPaths(ROOT, 'abc123')

  it('starts the journal script under a session of its own', () => {
    // Measured (`scripts/spike-e2b-session.ts`): a bare wrapper runs in envd's session 511
    // along with every other command in the sandbox, so `pgrep -s` cannot tell a turn's
    // survivor from anything else running there. Under `setsid` the wrapper is a session
    // leader, which is what makes the survivor question askable at all (#266).
    expect(journalledCommand(['claude'], paths).startsWith(SESSION_OPEN)).toBe(true)
    expect(SESSION_OPEN).toContain('--wait')
  })

  it('hands the whole journal script over as one word, redirections included', () => {
    // Prefixing without quoting would hand `setsid` the argv and leave the redirections to
    // the outer shell, so the journal would be written by a process outside the session.
    const command = journalledCommand(['echo', 'hi'], paths)

    expect(journalledScriptIn(command)).toBe(
      `{ 'echo' 'hi' ; } > '${ROOT}/abc123.out' 2> '${ROOT}/abc123.err'`
      + ` ; printf '%s' "$?" > '${ROOT}/abc123.exit'`,
    )
  })

  it('reads the script back out of the line e2b lists, whatever prompt is inside it', () => {
    // The line arrives with e2b's own shell in front of it, and the argv is
    // tracker-authored: a prompt naming the session prefix must not move where the peel
    // starts, because everything the recovery reads is located relative to it.
    const command = journalledCommand(['claude', '-p', `pretend ${SESSION_OPEN}'x'`], paths)

    expect(journalledScriptIn(`/bin/bash -l -c ${command}`))
      .toBe(journalledScriptIn(command))
    expect(journalledScriptIn(command)).toContain(`> '${ROOT}/abc123.out'`)
  })

  it('does not peel a legacy wrapper at a prefix its own prompt is quoting', () => {
    // A turn prompt carries an issue body, and an issue about *this feature* contains
    // `setsid --wait sh -c '…'` in a code span. In a legacy wrapper there is no prefix of
    // ours anywhere in the line, so the first occurrence of it is the prompt's — and peeling
    // there returns the fragment inside the prompt, which holds neither the journal
    // redirection nor the argv. The wrapper then reads as "not a journal wrapper", the
    // duplicate-turn guard cannot see a live turn, and `liveTurnProcess` starts a second
    // `claude` in the same checkout: the failure PR #260 exists to prevent.
    const legacy = legacyWrapper(
      ['claude', '-p', `run ${SESSION_OPEN}'{ echo hi ; }' to detach`],
      journalPaths(ROOT, 'abc123'),
    )

    expect(journalledScriptIn(`/bin/bash -l -c ${legacy}`)).toBe(`/bin/bash -l -c ${legacy}`)
  })

  it('does not lose its place at an apostrophe earlier in the same prompt', () => {
    // The scan has to read `quoteArg`'s grammar, not toggle on every `'`. An apostrophe is
    // emitted as `'\''` — a quote that *ends* a segment, an escaped quote outside quoting,
    // then a quote that opens the next — so a toggle that treats all three alike finishes the
    // apostrophe with its state inverted and reports the rest of the prompt as top level.
    // `it's` plus a quoted prefix after it is therefore the shape that separates the two
    // readings; the prefix alone does not, because both readings see it as quoted.
    const legacy = legacyWrapper(
      ['claude', '-p', `it's ${SESSION_OPEN}'{ echo hi ; }' now`],
      journalPaths(ROOT, 'abc123'),
    )

    expect(journalledScriptIn(`/bin/bash -l -c ${legacy}`)).toBe(`/bin/bash -l -c ${legacy}`)
  })

  it('still peels our own wrapper when its argv quotes the prefix too', () => {
    // The other half: the rule must not start refusing the lines we write. Ours is emitted
    // unquoted and always precedes the script, so it is the first *top-level* occurrence
    // however many quoted ones the prompt carries after it.
    const argv = ['claude', '-p', `see ${SESSION_OPEN}'{ echo hi ; }' in the issue`]
    const command = journalledCommand(argv, journalPaths(ROOT, 'abc123'))

    const script = journalledScriptIn(`/bin/bash -l -c ${command}`)
    expect(script.startsWith('{ ')).toBe(true)
    expect(script).toContain(`> '${ROOT}/abc123.out'`)
    expect(unquoteArgv(script.slice(2, script.lastIndexOf(' ; } > ')))).toEqual(argv)
  })

  it('leaves a wrapper started before this existed readable as it is', () => {
    // Those are still running in sandboxes this code connects to, and one read as "not a
    // journal wrapper" is a live turn the duplicate-turn guard cannot see.
    const legacy = `{ 'claude' ; } > '${ROOT}/abc123.out' 2> '${ROOT}/abc123.err'`

    expect(journalledScriptIn(legacy)).toBe(legacy)
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
