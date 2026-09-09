import { describe, expect, it, vi } from 'vitest'
import { encode, fakeSandbox, ROOT, session } from './daytona-session.fixtures'

/** The wrapper writes this itself; a test writes it in the wrapper's place. */
function recordPid(fake: ReturnType<typeof fakeSandbox>, processId: string, pid: string): void {
  fake.files.set(`${ROOT}/${processId}.pid`, encode(pid))
}

describe('kill', () => {
  /**
   * Daytona has no signal API for a session command (research note 035 §3), so a kill is an
   * ordinary `kill(1)` aimed at the pid the wrapper recorded — and the default takes the whole
   * process *group*, which is what `setsid` in the wrapper made reachable.
   */
  it('signals the group by default, so a turn\'s children go with it', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    recordPid(fake, 'run-1', '4242')

    await handle.kill()
    expect(fake.ran).toEqual(['kill -KILL -- -4242'])
  })

  /**
   * A group kill fails where the pid does not lead one — an image without `setsid`, or a turn
   * already reaped down to a reparented child. The fallback is strictly *narrower* than what was
   * asked for, so it can never exceed the caller's request.
   */
  it('falls back to the process itself when the group kill does not land', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    recordPid(fake, 'run-1', '4242')
    fake.exitCodes.set('kill -KILL -- -', 1)

    await handle.kill()
    expect(fake.ran).toEqual(['kill -KILL -- -4242', 'kill -KILL 4242'])
  })

  /**
   * A caller that names a signal is asking something of the *process*: SIGINT is how the `claude`
   * CLI is asked to end the turn and print its `result`, and broadcasting that to a group would
   * interrupt every child instead.
   */
  it('sends a named signal to the process alone, and only once', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    recordPid(fake, 'run-1', '4242')

    await handle.kill(2)
    expect(fake.ran).toEqual(['kill -2 4242'])
  })

  /**
   * A readable pid is no guarantee the signal lands: the process may already be gone. Non-delivery
   * is reported wherever it happens, so the caller's escalation is not waiting on a kill that was
   * silently dropped.
   */
  it('reports a named signal the process did not take', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    recordPid(fake, 'run-1', '4242')
    fake.exitCodes.set('kill -2 ', 1)

    await handle.kill(2)
    expect(fake.ran).toEqual(['kill -2 4242'])
    expect(warn.mock.calls.map(([message]) => String(message)).join('\n'))
      .toMatch(/could not deliver signal 2 to process=4242/)
    warn.mockRestore()
  })

  /**
   * The provider that kills is routinely not the one that started the turn — a retried step runs
   * on another instance — so the pid comes off the file rather than out of memory.
   */
  it('kills from the pid file, so a cold session can still reach the process', async () => {
    const fake = fakeSandbox()
    await session(fake).exec(['claude'])
    recordPid(fake, 'run-1', '4242')

    await (await session(fake, ['unused']).getProcess('run-1'))?.kill()
    expect(fake.ran).toEqual(['kill -KILL -- -4242'])
  })

  /**
   * The contract forbids answering a named signal with a harsher one: a SIGKILL sent where SIGINT
   * was asked for ends the turn without the `result` the interrupt exists to collect. So a
   * non-deliverable named signal is reported and nothing else happens — the caller's bounded wait
   * then times out and escalates to the default kill.
   */
  it('reports a named signal it cannot deliver rather than substituting a harsher one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])

    await handle.kill(2)
    expect(fake.ran).toEqual([])
    expect(fake.sessions.has('run-1')).toBe(true)
    expect(warn.mock.calls.map(([message]) => String(message)).join('\n')).toMatch(/cannot deliver signal 2/)
    warn.mockRestore()
  })

  /** The default kill has one lever left when no pid was ever recorded, and it says so. */
  it('deletes the session when a default kill has no pid to aim at', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])

    await handle.kill()
    expect(fake.ran).toEqual([])
    expect(fake.sessions.has('run-1')).toBe(false)
    expect(warn.mock.calls.map(([message]) => String(message)).join('\n')).toMatch(/no recorded pid/)
    warn.mockRestore()
  })

  /** A garbled pid file is no pid at all: `kill -KILL -- -0` would signal every process. */
  it('refuses a pid file that does not name a killable process', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    recordPid(fake, 'run-1', 'not-a-pid')

    await handle.kill()
    expect(fake.ran).toEqual([])
    warn.mockRestore()
  })
})
