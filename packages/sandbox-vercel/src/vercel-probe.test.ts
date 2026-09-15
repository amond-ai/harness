import { describe, expect, it, vi } from 'vitest'
import { journalPaths } from './journal'
import { createJournalProbe, parseProbeOutput, probeScript } from './vercel-probe'
import { encode, fakeCommand, fakeSandbox, ROOT } from './vercel-sandbox.fake'

const META = {
  id: 'p1',
  cmdId: 'cmd_1',
  sessionId: 'ses_1',
  command: ['claude', '-p'] as const,
  startedAt: '2026-09-14T13:00:00.000Z',
}

const PATHS = journalPaths(ROOT, 'p1')

describe('probeScript', () => {
  it('is exactly the command line the sandbox runs', () => {
    // CI never puts this through a real shell, so its *text* is the artefact under test. Silent
    // drift here does not fail a type check or a unit test — it fails liveness in production,
    // where a probe that prints four fields instead of five reads as `'unknown'` forever and a
    // wedged turn is never reported. Verified once against a real `sh` (2026-09-14): clean
    // stderr for a journal that does not exist yet, exit 0 in every state, and `head -c 32`
    // capping a 200-byte exit record at 32.
    expect(probeScript('p1', '/journal')).toBe(
      `m='sh -c : '\\''p1'\\'' ; '`
      + ` ; g=$(cat 2> /dev/null < '/journal/p1.pgid')`
      + ` ; c=$(tr 2> /dev/null '\\0' ' ' < /proc/"$g"/cmdline)`
      + ` ; if [ -z "$g" ] ; then printf '%s\\n' nopid`
      + ` ; elif [ -n "$c" ] ; then case $c in "$m"*) printf '%s\\n' live ;;`
      + ` *) printf '%s\\n' stranger ;; esac`
      + ` ; else if kill -0 -- -"$g" 2> /dev/null ; then printf '%s\\n' survivors`
      + ` ; else printf '%s\\n' none ; fi ; fi`
      + ` ; if [ -f '/journal/p1.out' ] ; then printf '%s\\n' "$(wc -c < '/journal/p1.out')" ; else printf '%s\\n' -1 ; fi`
      + ` ; if [ -f '/journal/p1.err' ] ; then printf '%s\\n' "$(wc -c < '/journal/p1.err')" ; else printf '%s\\n' -1 ; fi`
      + ` ; if [ -f '/journal/p1.timeout' ] ; then printf '%s\\n' t ; else printf '%s\\n' '' ; fi`
      + ` ; head -c 32 2> /dev/null < '/journal/p1.exit'`
      + ` ; exit 0`,
    )
  })

  it('reads liveness before the exit record, and ends with exit 0', () => {
    const script = probeScript('p1', '/journal')
    // The unsound reading this ordering removes is "gone at T1, no record at T2 > T1" called
    // `no_exit_record` — wrong exactly when the wrapper published between the two, which is the
    // likeliest moment, since it exits microseconds after the rename.
    expect(script.indexOf('kill -0 -- -"$g"')).toBeLessThan(script.indexOf('head -c 32'))
    // `head` on an absent exit record exits non-zero on almost every poll of a running turn, and
    // a non-zero probe means "the probe failed", never anything about the turn.
    expect(script.endsWith(' ; exit 0')).toBe(true)
  })

  it('asks kill, not pgrep, and matches the cmdline marker rather than the bare pid', () => {
    const script = probeScript('p1', '/journal')
    // `kill` is a builtin and is in every image; `pgrep` is procps and may not be.
    expect(script).not.toContain('pgrep')
    // A pid alone proves nothing — pids are recycled, and `kill -0` on a recycled one succeeds.
    expect(script).toContain(`m='sh -c : '\\''p1'\\'' ; '`)
    expect(script).toContain('/proc/"$g"/cmdline')
  })

  it('consults the group only when the pid is not in use at all', () => {
    const script = probeScript('p1', '/journal')
    // The branch order is the substantive part: a stranger that recycled the pid and leads its
    // own group answers `kill -0 -- -$g` perfectly well, so asking the group first reports an
    // unrelated process as this turn's survivors. A readable `/proc/<pid>/cmdline` means the pid
    // is in use and settles it; only an unreadable one reaches the group at all, and a pid
    // cannot be reused while a group of that id still has members — so a non-empty group there
    // can only be our own orphans.
    expect(script.indexOf(`elif [ -n "$c" ]`)).toBeLessThan(script.indexOf('kill -0 -- -"$g"'))
  })
})

describe('parseProbeOutput', () => {
  it('reads a live wrapper', () => {
    expect(parseProbeOutput('live\n12\n3\n\n')).toEqual({
      liveness: 'live',
      group: 'live',
      answered: true,
      out: 12,
      err: 3,
      timedOut: false,
      exitCode: undefined,
      corroborated: false,
    })
  })

  it('reads a wrapper whose children outlived it as still live', () => {
    // A turn whose `git` or language server demonstrably has not stopped has not stopped;
    // reporting it finished is what lets a retry clone over a tree something is still writing to.
    const reading = parseProbeOutput('survivors\n0\n0\n\n')
    expect(reading.group).toBe('survivors')
    expect(reading.liveness).toBe('live')
  })

  it('reads an empty group as gone, with its exit record and timeout marker', () => {
    expect(parseProbeOutput('none\n40\n0\nt\n137')).toEqual({
      liveness: 'gone',
      group: 'none',
      answered: true,
      out: 40,
      err: 0,
      timedOut: true,
      // Journalled, not corroborated: a code read out of a file the turn can write is believed
      // only once the group agrees it is gone, which is `statusOf`'s step 4 and not its step 1.
      exitCode: 137,
      corroborated: false,
    })
  })

  it('never collapses an unanswerable probe into gone', () => {
    // `'gone'` is what makes a caller stop waiting and report `no_exit_record`, which settles a
    // run as failed and releases the checkout. Answering it because the probe could not run
    // would release a checkout a live agent is still writing to.
    for (const output of ['nopid\n-1\n-1\n\n', 'garbage\n-1\n-1\n\n', '', 'live\n1\n2']) {
      expect(parseProbeOutput(output).liveness).not.toBe('gone')
    }
    expect(parseProbeOutput('nopid\n-1\n-1\n\n').liveness).toBe('unknown')
    // Fewer than five fields is a response this module did not write, whatever it says.
    expect(parseProbeOutput('live\n1\n2')).toEqual(
      // `answered: false` and not merely `liveness: 'unknown'`: a follow read starting at the
      // live tail needs to tell "no journal file yet, so zero" from "no answer at all", where
      // zero would replay a whole transcript into a subscriber that asked for none of it.
      { liveness: 'unknown', group: 'unknown', answered: false, out: -1, err: -1, timedOut: false, corroborated: false },
    )
  })

  it('tolerates the padding BSD wc puts in front of a count', () => {
    // Measured on macOS 2026-09-14: `wc -c < file` answers `       5`. GNU coreutils does not
    // pad, and the probe runs on both.
    expect(parseProbeOutput('none\n       5\n       0\n\n').out).toBe(5)
  })

  it('keeps a forged multi-line exit record from shifting the fields before it', () => {
    // The record is the last field precisely so everything after the fourth newline is the
    // record, whatever a turn wrote into it.
    const reading = parseProbeOutput('live\n7\n8\n\nnot\na\ncode')
    expect(reading.out).toBe(7)
    expect(reading.err).toBe(8)
    expect(reading.exitCode).toBeUndefined()
  })
})

describe('createJournalProbe', () => {
  it('answers liveness, lengths and the exit record from one command', () => {
    const fake = fakeSandbox()
    fake.files.set(PATHS.pgid, encode('501'))
    fake.files.set(PATHS.out, encode('hello'))
    fake.procs.set(501, { cmdline: `sh -c : 'p1' ; printf`, pgid: 501 })

    return createJournalProbe(fake.sandbox, ROOT).read(META).then((reading) => {
      expect(reading).toMatchObject({ liveness: 'live', group: 'live', out: 5, err: -1 })
      // One command, which is the whole point of this module.
      expect(fake.calls.runCommand).toBe(1)
    })
  })

  it('reads a recycled pid as gone rather than as this turn', async () => {
    const fake = fakeSandbox()
    fake.files.set(PATHS.pgid, encode('501'))
    // The pid is alive and leads a group; it is simply not ours. What a caller does with a
    // `'live'` answer includes signalling it, so this is a killed bystander, not a wrong label.
    fake.procs.set(501, { cmdline: '/usr/libexec/secretd -x', pgid: 501 })

    expect((await createJournalProbe(fake.sandbox, ROOT).read(META)).liveness).toBe('gone')
  })

  it('reads a probe the sandbox refused as unknown, never as gone', async () => {
    const fake = fakeSandbox()
    fake.failing.add('-c')

    expect((await createJournalProbe(fake.sandbox, ROOT).read(META)).liveness).toBe('unknown')
  })

  it('prefers the exit code Vercel recorded over the one the turn could have forged', async () => {
    const fake = fakeSandbox()
    fake.files.set(PATHS.pgid, encode('501'))
    fake.files.set(PATHS.exit, encode('0'))
    fake.commands.set('cmd_1', fakeCommand('cmd_1', 137))

    // `<id>.exit` lives on a filesystem the turn writes to; a command's `exitCode` is the API's
    // own record of how the process it started ended.
    const reading = await createJournalProbe(fake.sandbox, ROOT).read(META)
    expect(reading.exitCode).toBe(137)
    // Flagged, not just preferred: it is the flag that lets `statusOf` settle on this code
    // without a liveness verdict, which is the one reading the turn cannot forge.
    expect(reading.corroborated).toBe(true)
  })

  it('falls through to the journal when the session moved on', async () => {
    const fake = fakeSandbox()
    fake.files.set(PATHS.pgid, encode('501'))
    fake.files.set(PATHS.exit, encode('0'))
    fake.commands.set('cmd_1', fakeCommand('cmd_1', 137))
    // A command id is scoped to the VM that ran it, and a retried step reattaches to a resumed
    // sandbox as a matter of course. The corroboration must not even be attempted there.
    fake.session = 'ses_2'

    const reading = await createJournalProbe(fake.sandbox, ROOT).read(META)
    expect(reading).toMatchObject({ exitCode: 0, corroborated: false })
    expect(fake.calls.getCommand).toBe(0)
  })

  it('falls through to the journal when the command is gone, without reporting it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    fake.files.set(PATHS.pgid, encode('501'))
    fake.files.set(PATHS.exit, encode('2'))

    // A 404 is the expected shape for a command the session no longer holds — corroboration
    // that could not be obtained is simply not applied, and costs the caller no answer.
    expect((await createJournalProbe(fake.sandbox, ROOT).read(META)).exitCode).toBe(2)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('short-circuits the lookup for a command this isolate started', async () => {
    const fake = fakeSandbox()
    fake.files.set(PATHS.pgid, encode('501'))
    const execCommands = new Map([['p1', fakeCommand('cmd_1', 3)]])

    expect((await createJournalProbe(fake.sandbox, ROOT, { execCommands }).read(META)).exitCode).toBe(3)
    expect(fake.calls.getCommand).toBe(0)
  })
})
