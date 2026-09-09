import { describe, expect, it, vi } from 'vitest'
import {
  AT,
  commandOf,
  encode,
  fakeSandbox,
  forgetSession,
  ROOT,
  session,
} from './daytona-session.fixtures'

describe('exec', () => {
  it('opens one session per process and starts the command asynchronously', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude', '-p', 'go'])

    expect(handle.id).toBe('run-1')
    expect([...fake.sessions.keys()]).toEqual(['run-1'])
    expect(commandOf(fake, 'run-1')?.exitCode).toBeUndefined()
  })

  /**
   * The wrapper is the whole of what Daytona does not give us: `$$` recorded before the command
   * runs (there is no pid in the API and no signal API either), `exec` so that pid is the
   * command's rather than a shell that will fork one, and `setsid --wait` so it is also the
   * process-group id the default kill signals.
   */
  it('wraps the argv so a pid is recorded and the command leads its own session', async () => {
    const fake = fakeSandbox()
    await session(fake).exec(['claude', '-p', `it's here`])

    expect(commandOf(fake, 'run-1')?.command).toBe(
      `setsid --wait sh -c 'printf '\\''%s'\\'' "$$" > '\\''${ROOT}/run-1.pid'\\'' ; `
      + `exec '\\''claude'\\'' '\\''-p'\\'' '\\''it'\\''\\'\\'''\\''s here'\\'''`,
    )
  })

  it('adds cd and env only where the caller asked for them', async () => {
    const fake = fakeSandbox()
    await session(fake).exec(['ls'], { cwd: '/workspace/repo', env: { TOKEN: 'a b' } })

    const command = commandOf(fake, 'run-1')?.command ?? ''
    expect(command).toContain(`cd '\\''/workspace/repo'\\'' && exec env '\\''TOKEN=a b'\\''`)
  })

  /**
   * Verified rather than trusted. A missing state root fails *silently* otherwise: the wrapper's
   * `printf … > <root>/<id>.pid` redirection dies, the shell never reaches the command, and the
   * caller learns only much later that the turn produced nothing.
   */
  it('creates the state root and refuses to start when it is still not there', async () => {
    const fake = fakeSandbox()
    await session(fake).exec(['ls'])
    expect(fake.dirs.has(ROOT)).toBe(true)

    const broken = fakeSandbox()
    broken.failing.add(ROOT)
    await expect(session(broken).exec(['ls'])).rejects.toThrow(/state root .* could not be created/)
    expect(broken.sessions.size).toBe(0)
  })

  it('records the argv, cwd and start time the daemon does not keep', async () => {
    const fake = fakeSandbox()
    await session(fake).exec(['claude', '-p', 'go'], { cwd: '/workspace' })

    expect(JSON.parse(new TextDecoder().decode(fake.files.get(`${ROOT}/run-1.meta.json`)))).toEqual({
      id: 'run-1',
      command: ['claude', '-p', 'go'],
      cwd: '/workspace',
      startedAt: AT,
    })
  })

  /**
   * A failed meta write leaves a turn running that `listProcesses` cannot see — it screens on the
   * meta file — so the duplicate-turn guard would start a second `claude` in the same checkout.
   * Killed here instead, so the caller's failure is a turn that did not start. The kill ends the
   * process and not the session holding it, so the session goes too — otherwise it survives its
   * own dead command, unscreenable for the same reason, until `destroy()` takes the sandbox.
   */
  it('kills the command it just started when the meta write fails, then reports', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fake = fakeSandbox()
    fake.failing.add(`${ROOT}/run-1.meta.json`)
    fake.files.set(`${ROOT}/run-1.pid`, encode('4242'))

    await expect(session(fake).exec(['claude'])).rejects.toThrow(/meta for 'run-1' could not be written/)
    expect(fake.ran).toEqual(['kill -KILL -- -4242'])
    expect([...fake.sessions.keys()]).toEqual([])
    warn.mockRestore()
  })

  /**
   * A command that never started leaves the session it was created for behind, and nothing else
   * can name it: no meta file was written, so `listProcesses` screens it out, and `destroy` only
   * reaches sessions the sandbox still lists. Deleted here, where the id is still in hand.
   */
  it('deletes the session it created when the command fails to start', async () => {
    const fake = fakeSandbox()
    fake.failing.add('exec:run-1')

    await expect(session(fake).exec(['claude'])).rejects.toThrow(/command refused/)
    expect([...fake.sessions.keys()]).toEqual([])
  })
})

describe('getProcess', () => {
  it('answers with a handle for a session Daytona still holds', async () => {
    const fake = fakeSandbox()
    await session(fake).exec(['claude', '-p', 'go'])

    const found = await session(fake, ['unused']).getProcess('run-1')
    expect(await found?.status()).toMatchObject({ state: 'running', command: ['claude', '-p', 'go'] })
  })

  /** The meta is informational, so a process is still a process without it. */
  it('names an unrecorded command rather than failing when the meta is gone', async () => {
    const fake = fakeSandbox()
    await session(fake).exec(['claude'])
    fake.files.delete(`${ROOT}/run-1.meta.json`)

    expect(await (await session(fake).getProcess('run-1'))?.status())
      .toMatchObject({ command: ['<unrecorded>'], state: 'running' })
  })

  /**
   * A sandbox stopped and restarted is not documented to keep its sessions (research note 035
   * §3). The meta file still on disk says the process existed, so `null` — which `killTurn` reads
   * as a confirmed death — would be the wrong answer.
   */
  it('reports a vanished session with a meta file as no_exit_record, not as absent', async () => {
    const fake = fakeSandbox()
    await session(fake).exec(['claude'])
    forgetSession(fake, 'run-1')

    const found = await session(fake).getProcess('run-1')
    expect(await found?.status()).toMatchObject({
      state: 'error',
      error: { code: 'no_exit_record' },
    })
  })

  it('answers null only when neither the session nor the meta is there', async () => {
    const fake = fakeSandbox()
    expect(await session(fake).getProcess('never-ran')).toBeNull()
    // A foreign id can never name a process here, and must not become a path either.
    expect(await session(fake).getProcess('../escape')).toBeNull()
  })

  /** A transport failure is not an absence: `null` would clear the way for a duplicate turn. */
  it('propagates a read failure rather than turning it into a confirmed death', async () => {
    const fake = fakeSandbox()
    await session(fake).exec(['claude'])
    fake.failing.add('run-1')

    await expect(session(fake).getProcess('run-1')).rejects.toThrow(/connection reset/)
  })
})

describe('listProcesses', () => {
  it('reports the processes this backend started, exited ones included', async () => {
    const fake = fakeSandbox()
    const runs = session(fake, ['run-1', 'run-2'])
    await runs.exec(['claude'])
    await runs.exec(['git', 'status'])
    commandOf(fake, 'run-2')!.exitCode = 0

    const listed = await runs.listProcesses()
    expect(listed.map(status => [status.id, status.state])).toEqual([['run-1', 'running'], ['run-2', 'exited']])
  })

  /**
   * A sandbox's session list is shared ground — Daytona always holds an entrypoint session, and a
   * turn can create its own. One foreign id must not take the whole listing with it, inside a
   * workflow step that is never retried.
   */
  it('skips foreign sessions rather than throwing on them', async () => {
    const fake = fakeSandbox()
    await session(fake).exec(['claude'])
    fake.sessions.set('entrypoint-session', [])
    fake.sessions.set('has/a/slash', [])

    expect((await session(fake).listProcesses()).map(status => status.id)).toEqual(['run-1'])
  })
})
