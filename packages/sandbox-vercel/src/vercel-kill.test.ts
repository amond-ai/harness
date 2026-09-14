import type { JournalMeta } from './journal'
import { describe, expect, it, vi } from 'vitest'
import { journalPaths } from './journal'
import { createJournalIo } from './journal-io'
import { createVercelKill } from './vercel-kill'
import { createJournalProbe } from './vercel-probe'
import { encode, fakeCommand, fakeSandbox, ROOT } from './vercel-sandbox.fake'

const META: JournalMeta = {
  id: 'p1',
  cmdId: 'cmd_1',
  sessionId: 'ses_1',
  command: ['claude', '-p'] as unknown as JournalMeta['command'],
  startedAt: '2026-09-14T13:00:00.000Z',
}

const PATHS = journalPaths(ROOT, 'p1')

function killPath(fake: ReturnType<typeof fakeSandbox>, execCommands?: Map<string, ReturnType<typeof fakeCommand>>) {
  const io = createJournalIo(fake.sandbox, ROOT)
  const probe = createJournalProbe(fake.sandbox, ROOT, { execCommands })
  return createVercelKill(fake.sandbox, ROOT, io, probe, { execCommands })
}

/** A turn as the wrapper leaves it: a group leader, its command, and a journalled pgid/pid. */
function runningTurn(fake: ReturnType<typeof fakeSandbox>, group = 501, pid = 502): void {
  fake.files.set(PATHS.pgid, encode(String(group)))
  fake.files.set(PATHS.pid, encode(String(pid)))
  fake.procs.set(group, { cmdline: `sh -c : 'p1' ; printf`, pgid: group })
  fake.procs.set(pid, { cmdline: 'claude -p', pgid: group })
}

describe('the default kill', () => {
  it('reaps the group, never the tracked command', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    runningTurn(fake)

    await killPath(fake)(META)

    // `Command.kill` signals what Vercel tracks, which under `setsid --wait` is the process the
    // API started. The e2b backend measured what a SIGKILL there does: the `claude` child
    // reparented to init, ran to completion, and no exit file was ever written.
    expect(fake.ran).toContainEqual({ cmd: 'sh', args: ['-c', 'kill -KILL -- -501'] })
    // The whole group, which under `setsid` is the turn and everything it started.
    expect(fake.procs.size).toBe(0)
    warn.mockRestore()
  })

  it('falls back to the command\'s own pid when the group kill is refused', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    // A pgid the wrapper wrote for a group that is already empty — `kill` answers non-zero.
    fake.files.set(PATHS.pgid, encode('501'))
    fake.files.set(PATHS.pid, encode('502'))
    fake.procs.set(502, { cmdline: 'claude -p', pgid: 777 })

    await killPath(fake)(META)

    // Strictly narrower than what was asked for, so it can never exceed the request.
    expect(fake.ran).toContainEqual({ cmd: 'sh', args: ['-c', 'kill -KILL -- -501'] })
    expect(fake.ran).toContainEqual({ cmd: 'sh', args: ['-c', 'kill -KILL 502'] })
    expect(fake.procs.size).toBe(0)
    warn.mockRestore()
  })

  it('refuses to claim a kill that left the group running', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    runningTurn(fake)
    // The kernel accepted the signal — the group had members — and something survived it anyway.
    // Resolving here is what a caller reads as a confirmed kill, after which it starts the next
    // attempt in the same checkout.
    fake.stubborn.add(502)

    await expect(killPath(fake)(META)).rejects.toThrow(/left processes running in its group/)
    warn.mockRestore()
  })

  it('does not fail a kill against a sandbox it could not re-probe', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    runningTurn(fake)
    // A probe that could not run has measured nothing, and failing every kill against an
    // unreachable sandbox is not what it learned.
    fake.failing.add('/proc/')

    await expect(killPath(fake)(META)).resolves.toBeUndefined()
    warn.mockRestore()
  })
})

describe('a named signal', () => {
  it('goes to the process and not to the group', async () => {
    const fake = fakeSandbox()
    runningTurn(fake)

    await killPath(fake)(META, 2)

    // SIGINT is how `claude` is asked to end the turn and still print its `result`. Broadcast to
    // the group it would reach the wrapper shell, which dies on it without running the `printf`
    // that records the exit — both halves of what the interrupt was for, lost.
    expect(fake.ran).toContainEqual({ cmd: 'sh', args: ['-c', 'kill -INT 502'] })
    expect(fake.ran.some(ran => ran.args.some(arg => arg.includes('-- -501')))).toBe(false)
  })

  it('spells the signal by name rather than by number', async () => {
    const fake = fakeSandbox()
    runningTurn(fake)

    await killPath(fake)(META, 15)
    await killPath(fake)(META, 9)

    // Signal numbers differ between architectures while the names do not, and a `kill -9` that
    // landed as a different signal on an arm image is a kill nobody could account for.
    expect(fake.ran).toContainEqual({ cmd: 'sh', args: ['-c', 'kill -TERM 502'] })
    expect(fake.ran).toContainEqual({ cmd: 'sh', args: ['-c', 'kill -KILL 502'] })
  })

  it('passes an unlisted number through rather than mapping it to a default', async () => {
    const fake = fakeSandbox()
    runningTurn(fake)

    await killPath(fake)(META, 17)

    expect(fake.ran).toContainEqual({ cmd: 'sh', args: ['-c', 'kill -17 502'] })
  })

  it('reports a non-delivery rather than substituting a harsher signal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    const execCommands = new Map([['p1', fakeCommand('cmd_1', null)]])

    // No pid recorded. The warm fallback sends SIGKILL, and substituting it for a named signal
    // is exactly what the contract forbids — a SIGKILL where SIGINT was asked for ends the turn
    // without the `result` the interrupt exists to collect.
    await killPath(fake, execCommands)(META, 2)

    expect(execCommands.get('p1')?.killed).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('signal 2 was not delivered'))
    warn.mockRestore()
  })
})

describe('a kill with no pid to aim at', () => {
  it('ends the tracked command and says the kill was partial', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    const execCommands = new Map([['p1', fakeCommand('cmd_1', null)]])

    await killPath(fake, execCommands)(META)

    // Better than nothing — it ends the head of the tree — and reported as partial, because the
    // measured outcome of exactly this is a reparented child that keeps running.
    expect(execCommands.get('p1')?.killed).toEqual(['SIGKILL'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('This is a partial kill'))
    warn.mockRestore()
  })

  it('says so when there is nothing left to signal at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    // Cold: the session moved on, so no handle resolves. The contract forbids a silent no-op,
    // and the log is that half; the caller's bounded wait is what escalates.
    fake.session = 'ses_2'

    await killPath(fake)(META)

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the kill was not delivered'))
    warn.mockRestore()
  })

  it('refuses a pid record that is not a pid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    // The file is the turn's to write. `0` and a negative would turn a pid kill into a *group*
    // kill of something nobody named, and `1e100` is an integer to JavaScript and not to a kernel.
    for (const forged of ['0', '-1', '1e100', 'not-a-pid', '9'.repeat(64)]) {
      fake.files.set(PATHS.pid, encode(forged))
      await killPath(fake)(META, 2)
    }

    expect(fake.ran).toEqual([])
    warn.mockRestore()
  })
})
