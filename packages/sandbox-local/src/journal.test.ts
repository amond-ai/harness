import { describe, expect, it } from 'vitest'
import {
  journalledScript,
  journalPaths,
  parseJournalScript,
  parseProcessRecord,
  serializeProcessRecord,
} from './journal'

const PATHS = journalPaths('/state', 'p1')

describe('journalPaths', () => {
  it('refuses an id that would resolve outside the state directory', () => {
    expect(() => journalPaths('/state', '../../etc/passwd')).toThrow(/invalid process id/)
  })

  it('joins onto a state directory however many separators it ends with', () => {
    // The trailing-separator trim is a scan rather than `/\/+$/` (CodeQL alert 5), and the
    // filesystem root is the case that separates it from `trimTrailingSlash`: here an empty
    // base is what keeps the join from doubling the leading separator.
    expect(journalPaths('/state///', 'p1').exit).toBe('/state/p1.exit')
    expect(journalPaths('/', 'p1').exit).toBe('/p1.exit')
  })
})

describe('journalledScript', () => {
  it('backgrounds the command so the pid it records is the command\'s own', () => {
    // A simple command backgrounded by `&` is forked and exec'd directly, so `$!` is the
    // command rather than a subshell standing in front of it — which is what makes a SIGINT
    // reach `claude` instead of the wrapper.
    expect(journalledScript(['echo', 'hi'], PATHS)).toBe(
      `: 'p1' ; 'echo' 'hi' > '/state/p1.out' 2> '/state/p1.err' & __c=$!`
      + ` ; printf '%s' "$__c" > '/state/p1.pid'`
      + ` ; wait $__c ; __e=$?`
      + ` ; printf '%s' "$__e" > '/state/p1.exit.pending'`
      + ` ; command -p mv -- '/state/p1.exit.pending' '/state/p1.exit'`,
    )
  })

  it('publishes the exit by a rename from a sibling, so no reader sees a prefix', () => {
    const script = journalledScript(['echo', 'hi'], PATHS)
    // Same directory, or `mv` is a copy across filesystems and the atomicity POSIX gives
    // `rename(2)` is gone — reintroducing the torn read the two-step write is here to remove.
    expect(script).toContain(`> '/state/p1.exit.pending' ; command -p mv -- '/state/p1.exit.pending' '/state/p1.exit'`)
    // `command -p` resolves `mv` on the system default PATH, not the command's own: a caller
    // that passes a narrowed `env` without a usable PATH would otherwise leave every command
    // in the sandbox unable to publish an exit at all — the wrapper's one unrecoverable failure.
    // `--` ends the options, because a state root beginning with `-` makes the pending path
    // read as a flag (`mv: illegal option -- w`) rather than as an operand.
    expect(script).toContain('command -p mv -- ')
    // And the pending name is invisible to the state directory's scan, which reads records by
    // their `.meta.json` suffix and would otherwise take `p1.exit.pending` for a process.
    expect(script).not.toContain('.meta.json')
    // The pid keeps its one `printf`, and the reason is latency rather than principle: `mv` is
    // a fork where `printf` is a builtin, and those milliseconds straddle the window in which
    // `exec()` hands back a handle a caller may immediately `kill()`.
    expect(script).toContain(`printf '%s' "$__c" > '/state/p1.pid' ;`)
  })

  it('records the exit from inside the tree, after the command has been waited on', () => {
    const script = journalledScript(['false'], PATHS)
    // The order is the durability guarantee: whoever spawned this may be gone by now.
    expect(script.indexOf('wait $__c')).toBeLessThan(script.indexOf(`mv -- '/state/p1.exit.pending'`))
  })

  it('keeps a state root that begins with a dash out of mv\'s option list', () => {
    // Without the operand separator the pending path is read as flags — `mv: illegal option
    // -- w` — so every command under such a root would finish without ever publishing an exit.
    const script = journalledScript(['echo', 'hi'], journalPaths('-state', 'p1'))
    expect(script).toContain(`command -p mv -- '-state/p1.exit.pending' '-state/p1.exit'`)
  })

  it('carries its own deadline, so a timeout outlives the orchestrator too', () => {
    const script = journalledScript(['sleep', '99'], PATHS, 1_500)
    expect(script).toContain(`{ sleep 1.5 ; kill -0 $__c 2> /dev/null`)
    // Marked before it is killed: the reader can only see the file afterwards, and the other
    // order leaves a window where a killed command reads as one that failed on its own.
    expect(script.indexOf(`printf t > '/state/p1.timeout'`)).toBeLessThan(script.indexOf('kill -TERM $__c'))
    expect(script).toContain('kill $__w 2> /dev/null')
  })

  it('escalates a deadline the command ignores, and ends what it left running', () => {
    const script = journalledScript(['sh', '-c', 'sleep 300 & wait'], PATHS, 1_000)
    // A command that handles SIGTERM exits cleanly; one that ignores it would otherwise run
    // forever with the wrapper still waiting on it, the timeout enforcing nothing.
    expect(script).toContain('kill -TERM $__c 2> /dev/null ; sleep 5 ; kill -KILL $__c')
    // And signalling the command alone bounds nothing when it has children: they stay in the
    // wrapper's group, so the caller's wait carries on past the deadline it set.
    expect(script).toContain(`[ -f '/state/p1.timeout' ] && kill -KILL -$$`)
    // The exit is recorded before the group signal, which reaches the wrapper too — the
    // rename included, since a record still under its pending name is one no reader can find.
    expect(script.indexOf(`mv -- '/state/p1.exit.pending' '/state/p1.exit'`))
      .toBeLessThan(script.indexOf('kill -KILL -$$'))
    // `-$$`, never `0`: both name this group when the wrapper leads one, but on a host that
    // failed to detach it, `0` would name the orchestrator's group and kill the application.
    expect(script).not.toContain('kill -KILL 0')
  })

  it('reaps nothing when the command ended on its own', () => {
    // A turn may deliberately leave a server running — the bridge does exactly that.
    expect(journalledScript(['claude', '-p'], PATHS)).not.toContain('kill -KILL')
  })

  it('leaves no watchdog behind when no timeout was asked for', () => {
    const script = journalledScript(['sleep', '99'], PATHS)
    expect(script).not.toContain('__w')
    expect(script).not.toContain('/state/p1.timeout')
  })
})

describe('parseJournalScript', () => {
  const lineFor = (argv: string[], id = 'p1'): string =>
    `/bin/sh -c ${journalledScript(argv, journalPaths('/state', id))}`

  it('reads a live wrapper back into the process it is running', () => {
    expect(parseJournalScript(lineFor(['claude', '-p', 'fix the bug']), '/state')).toEqual({
      id: 'p1',
      command: ['claude', '-p', 'fix the bug'],
    })
  })

  it('is not talked out of the answer by an argv that quotes its own markers', () => {
    // A turn's prompt carries an issue body, and an issue about this very feature would quote
    // the script. The id is read from the opener and every other anchor is *derived* from it,
    // so the only string that can be mistaken for the real redirection is the real one.
    const prompt = `see: 'evil' ; rm -rf / > '/state/p9.out' 2> '/state/p9.err' & __c=$!`
    expect(parseJournalScript(lineFor(['claude', '-p', prompt]), '/state')).toEqual({
      id: 'p1',
      command: ['claude', '-p', prompt],
    })
  })

  it('claims nothing that belongs to another state directory, or to no one', () => {
    expect(parseJournalScript(lineFor(['echo', 'hi']), '/elsewhere')).toBeUndefined()
    expect(parseJournalScript('/usr/libexec/secretd -x', '/state')).toBeUndefined()
    expect(parseJournalScript(`/bin/sh -c : 'p1' ; not-quoted-argv`, '/state')).toBeUndefined()
  })

  it('claims nothing that merely mentions a wrapper', () => {
    // A marker found somewhere in a command line says only that a process has this text among
    // its arguments — an editor holding the file open, a grep for it, the turn's own claude
    // carrying it inside a prompt. Recovery hands what it finds to destroy(), which signals the
    // process group, so matching a stranger is not a wrong label but a killed bystander.
    const wrapper = journalledScript(['claude', '-p'], journalPaths('/state', 'p1'))
    for (const line of [
      `grep -R ${wrapper} /var/log`,
      `/usr/bin/vim ${wrapper}`,
      `/bin/zsh -c ${wrapper}`,
    ]) {
      expect(parseJournalScript(line, '/state')).toBeUndefined()
    }
    // And still claims its own.
    expect(parseJournalScript(`/bin/sh -c ${wrapper}`, '/state')).toEqual({
      id: 'p1',
      command: ['claude', '-p'],
    })
  })
})

describe('parseProcessRecord', () => {
  const record = {
    id: 'p1',
    pid: 4711,
    command: ['claude', '-p'] as const,
    cwd: '/work',
    startedAt: '2026-09-12T13:00:00.000Z',
    kernelStartedAt: 'Fri Sep 12 21:33:01 2026',
  }

  it('round-trips a record', () => {
    expect(parseProcessRecord(serializeProcessRecord(record))).toEqual(record)
  })

  it('reports anything that is not one as absent', () => {
    // The file lives where the command itself can write, so every field is checked rather than
    // cast — including the elements of `command`, whose tuple type nothing else enforces.
    for (const raw of [
      'not json',
      '[]',
      'null',
      JSON.stringify({ ...record, command: [] }),
      JSON.stringify({ ...record, command: ['claude', 5] }),
      JSON.stringify({ ...record, pid: 0 }),
      JSON.stringify({ ...record, pid: 1.5 }),
      JSON.stringify({ ...record, startedAt: 1 }),
    ]) {
      expect(parseProcessRecord(raw)).toBeUndefined()
    }
  })

  it('refuses a pid no host could be asked about', () => {
    // `1e100` is an integer to JavaScript and not a pid to anything else, so `isInteger` lets
    // it through and the host refuses it at the liveness probe instead — one malformed file
    // turning into a process that can never be resolved either way.
    expect(parseProcessRecord(JSON.stringify({ ...record, pid: 1e100 }))).toBeUndefined()
  })

  it('refuses an id no journal path can be built from', () => {
    // `registry.list()` trusts this field and hands it to `journalPaths()`, which throws on
    // anything outside `[A-Za-z0-9_-]+`. Unguarded, a single bad `.meta.json` fails the listing
    // for the whole sandbox rather than for itself.
    expect(parseProcessRecord(JSON.stringify({ ...record, id: '../../etc/passwd' }))).toBeUndefined()
  })
})
