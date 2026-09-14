import { describe, expect, it } from 'vitest'
import {
  journalledScript,
  journalPaths,
  parseJournalMeta,
  parseJournalScript,
  serializeJournalMeta,
  WRAPPER_SHELL,
} from './journal'

const ROOT = '/vercel/sandbox/.agent-runs'
const PATHS = journalPaths(ROOT, 'p1')

describe('journalPaths', () => {
  it('derives every artefact of one process from its id', () => {
    expect(journalPaths(ROOT, 'p1')).toEqual({
      out: `${ROOT}/p1.out`,
      err: `${ROOT}/p1.err`,
      exit: `${ROOT}/p1.exit`,
      exitPending: `${ROOT}/p1.exit.pending`,
      pid: `${ROOT}/p1.pid`,
      pgid: `${ROOT}/p1.pgid`,
      timeout: `${ROOT}/p1.timeout`,
      meta: `${ROOT}/p1.meta.json`,
    })
  })

  it('joins onto a root however many separators it ends with', () => {
    expect(journalPaths('/journal///', 'p1').exit).toBe('/journal/p1.exit')
    expect(journalPaths('/', 'p1').exit).toBe('/p1.exit')
  })

  it('refuses an id that would resolve outside the journal root', () => {
    expect(() => journalPaths(ROOT, '../../etc/passwd')).toThrow(/invalid process id/)
    expect(() => journalPaths(ROOT, 'a/b')).toThrow(/invalid process id/)
    expect(() => journalPaths(ROOT, '')).toThrow(/invalid process id/)
  })
})

describe('journalledScript', () => {
  it('is exactly the script the sandbox is asked to run', () => {
    // The one assertion in this file with nothing derived in it. Every other test reads the
    // script back through the module's own helpers, so a marker that was malformed and a parse
    // malformed in the mirror-image way would leave them all green while the sandbox runs
    // something else. This is what catches quoting no shell would accept.
    expect(journalledScript(['echo', 'hi'], journalPaths('/journal', 'p1'))).toBe(
      `: 'p1' ; printf '%s' "$$" > '/journal/p1.pgid'`
      + ` ; { 'echo' 'hi' ; } > '/journal/p1.out' 2> '/journal/p1.err' & __c=$!`
      + ` ; printf '%s' "$__c" > '/journal/p1.pid'`
      + ` ; wait $__c ; __e=$?`
      + ` ; printf '%s' "$__e" > '/journal/p1.exit.pending'`
      + ` ; command -p mv -- '/journal/p1.exit.pending' '/journal/p1.exit'`,
    )
  })

  it('records the group before anything else can fail', () => {
    // Under `setsid` the wrapper leads the group, so `$$` is the handle a kill of the whole turn
    // is aimed at — and the one thing no later bookkeeping recovers once the wrapper is gone.
    const script = journalledScript(['claude', '-p'], PATHS)
    expect(script.indexOf(`printf '%s' "$$" > '${ROOT}/p1.pgid'`))
      .toBeLessThan(script.indexOf(`${ROOT}/p1.out`))
  })

  it('backgrounds the command so the pid it records is the command\'s own', () => {
    // A simple command backgrounded by `&` is forked and exec'd directly, so `$!` is the command
    // rather than a subshell standing in front of it — which is what makes a SIGINT reach
    // `claude` instead of the wrapper shell, which would die on it before recording the exit.
    expect(journalledScript(['claude', '-p'], PATHS))
      .toContain(`& __c=$! ; printf '%s' "$__c" > '${ROOT}/p1.pid'`)
  })

  it('records the exit from inside the sandbox, after the command has been waited on', () => {
    // The order is the durability guarantee: the orchestrator that spawned this may be gone.
    const script = journalledScript(['false'], PATHS)
    expect(script.indexOf('wait $__c')).toBeLessThan(script.indexOf(`mv -- '${ROOT}/p1.exit.pending'`))
  })

  it('publishes the exit by a rename from a sibling, so no reader sees a prefix', () => {
    const script = journalledScript(['echo', 'hi'], PATHS)
    // Same directory, or `mv` is a copy across filesystems and the atomicity POSIX gives
    // `rename(2)` is gone — reintroducing the torn read the two-step write is here to remove.
    expect(script).toContain(
      `> '${ROOT}/p1.exit.pending' ; command -p mv -- '${ROOT}/p1.exit.pending' '${ROOT}/p1.exit'`,
    )
    // `command -p` resolves `mv` on the system default PATH, not the command's own:
    // `SandboxExecOptions.env` exists to be narrowed, and an env without a usable PATH would
    // leave every command in the sandbox unable to publish an exit at all.
    expect(script).toContain('command -p mv -- ')
  })

  it('keeps a journal root that begins with a dash out of mv\'s option list', () => {
    // Without the operand separator the pending path is read as flags — `mv: illegal option
    // -- w` — so every command under such a root would finish without ever publishing an exit.
    expect(journalledScript(['echo', 'hi'], journalPaths('-journal', 'p1')))
      .toContain(`command -p mv -- '-journal/p1.exit.pending' '-journal/p1.exit'`)
  })

  it('quotes the argv, so a prompt cannot break out into the wrapper', () => {
    const script = journalledScript(['claude', '-p', `x'; rm -rf / #`], PATHS)
    expect(script).toContain(`'x'\\''; rm -rf / #'`)
    // The payload must not survive unescaped anywhere in the script. Quoted, the `x` is followed
    // by `'\''` rather than by `';`, so dropping the escaping is what makes this appear.
    expect(script).not.toContain(`x'; rm -rf / #`)
  })

  it('carries its own deadline, so a timeout outlives the orchestrator too', () => {
    const script = journalledScript(['sleep', '99'], PATHS, 1_500)
    expect(script).toContain(`{ sleep 1.5 ; kill -0 $__c 2> /dev/null`)
    // Marked before it is killed: the reader can only see the file afterwards, and the other
    // order leaves a window where a killed command reads as one that failed on its own.
    expect(script.indexOf(`printf t > '${ROOT}/p1.timeout'`)).toBeLessThan(script.indexOf('kill -TERM $__c'))
    // A command that handles SIGTERM exits cleanly; one that ignores it would otherwise run
    // forever with the wrapper still waiting on it, the timeout enforcing nothing.
    expect(script).toContain('kill -TERM $__c 2> /dev/null ; sleep 5 ; kill -KILL $__c')
    expect(script).toContain('kill $__w 2> /dev/null')
  })

  it('leaves no watchdog behind when no timeout was asked for', () => {
    const script = journalledScript(['sleep', '99'], PATHS)
    expect(script).not.toContain('__w')
    expect(script).not.toContain(`${ROOT}/p1.timeout`)
  })

  it('ends what a timed-out command left running, and reaps nothing otherwise', () => {
    const script = journalledScript(['sh', '-c', 'sleep 300 & wait'], PATHS, 1_000)
    // Signalling the command alone bounds nothing when it has children: they stay in the
    // wrapper's group, a non-empty group reads as a live turn, and the caller's wait carries on
    // past the deadline it set.
    expect(script).toContain(`[ -f '${ROOT}/p1.timeout' ] && kill -KILL -$$`)
    // The exit is recorded before the group signal, which reaches the wrapper too — the rename
    // included, since a record still under its pending name is one no reader can find.
    expect(script.indexOf(`mv -- '${ROOT}/p1.exit.pending' '${ROOT}/p1.exit'`))
      .toBeLessThan(script.indexOf('kill -KILL -$$'))
    // `-$$`, never `0`: both name this group when the wrapper leads one, but on a session that
    // failed to start it under `setsid`, `0` would name the orchestrator's group.
    expect(script).not.toContain('kill -KILL 0')
    // A turn may deliberately leave a server running — the bridge does exactly that — so an
    // untimed command reaps nothing at all.
    expect(journalledScript(['claude', '-p'], PATHS)).not.toContain('kill -KILL')
  })

  it('splices neither a cd nor an env, which ride the run parameters instead', () => {
    // Unlike the Daytona backend: `RunCommandParams` carries `cwd` and `env` natively, and the
    // fewer things the script says the fewer there are for a prompt to be mistaken for.
    const script = journalledScript(['claude'], PATHS)
    expect(script).not.toContain('cd ')
    expect(script).not.toContain('env ')
  })
})

describe('parseJournalScript', () => {
  const lineFor = (argv: string[], id = 'p1'): string =>
    `${WRAPPER_SHELL} -c ${journalledScript(argv, journalPaths(ROOT, id))}`

  it('reads a live wrapper back into the process it is running', () => {
    expect(parseJournalScript(lineFor(['claude', '-p', 'fix the bug']), ROOT)).toEqual({
      id: 'p1',
      command: ['claude', '-p', 'fix the bug'],
    })
  })

  it('is not talked out of the answer by an argv that quotes its own markers', () => {
    // A turn's prompt carries an issue body, and an issue about this very feature would quote
    // the script. The id is read from the opener and every other anchor is *derived* from it, so
    // the only string that can be mistaken for the real redirection is the real one.
    const prompt = `see: 'evil' ; { rm -rf / ; } > '${ROOT}/p9.out' 2> '${ROOT}/p9.err' & __c=$!`
    expect(parseJournalScript(lineFor(['claude', '-p', prompt]), ROOT)).toEqual({
      id: 'p1',
      command: ['claude', '-p', prompt],
    })
  })

  it('claims nothing that belongs to another journal root, or to no one', () => {
    expect(parseJournalScript(lineFor(['echo', 'hi']), '/elsewhere')).toBeUndefined()
    expect(parseJournalScript('/usr/bin/node /opt/agent.js', ROOT)).toBeUndefined()
    expect(parseJournalScript(`${WRAPPER_SHELL} -c : 'p1' ; not-a-wrapper`, ROOT)).toBeUndefined()
  })

  it('claims nothing that merely mentions a wrapper', () => {
    // A marker found somewhere in a command line says only that a process has this text among
    // its arguments — a grep for it, or the turn's own claude carrying it in a prompt. What
    // recovery finds may be signalled, so matching a stranger is a killed bystander.
    const wrapper = journalledScript(['claude', '-p'], PATHS)
    for (const line of [`grep -R ${wrapper} /var/log`, `/usr/bin/vim ${wrapper}`, `bash -c ${wrapper}`]) {
      expect(parseJournalScript(line, ROOT)).toBeUndefined()
    }
    // And still claims its own.
    expect(parseJournalScript(`${WRAPPER_SHELL} -c ${wrapper}`, ROOT))
      .toEqual({ id: 'p1', command: ['claude', '-p'] })
  })
})

describe('journal meta', () => {
  const meta = {
    id: 'p1',
    cmdId: 'cmd_2f9',
    sessionId: 'ses_71a',
    command: ['claude', '-p', 'do it'] as const,
    cwd: '/vercel/sandbox/repo',
    startedAt: '2026-09-14T13:00:00.000Z',
  }

  it('round-trips what the backend must remember about a process', () => {
    expect(parseJournalMeta(serializeJournalMeta(meta))).toEqual(meta)
  })

  it('reports anything that is not one as absent rather than throwing', () => {
    // The file lives where the turn itself can write, so every field is checked rather than
    // cast — including the elements of `command`, whose tuple type nothing else enforces, and
    // the id, which a listing would otherwise hand to `journalPaths()` for the whole sandbox.
    for (const raw of [
      'not json',
      '[]',
      'null',
      '{"id":"p1"}',
      JSON.stringify({ ...meta, command: [] }),
      JSON.stringify({ ...meta, command: ['claude', 5] }),
      JSON.stringify({ ...meta, cmdId: 7 }),
      JSON.stringify({ ...meta, sessionId: undefined }),
      JSON.stringify({ ...meta, startedAt: 1 }),
      JSON.stringify({ ...meta, id: '../../etc/passwd' }),
    ]) {
      expect(parseJournalMeta(raw)).toBeUndefined()
    }
  })
})
