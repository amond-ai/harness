import { describe, expect, it, vi } from 'vitest'
import { journalPaths } from './journal'
import { AT, decode, encode, fakeSandbox, ROOT } from './vercel-sandbox.fake'
import { createVercelSession } from './vercel-session'
import { endProcess, forgeExit, killWrapperOnly, startProcess } from './vercel-session.fixtures'

function session(fake: ReturnType<typeof fakeSandbox>, ids: string[] = ['p1']) {
  const minted = [...ids]
  return createVercelSession(fake.sandbox, {
    journalRoot: ROOT,
    newProcessId: () => minted.shift() ?? 'spare',
    now: () => AT,
    pollIntervalMs: 0,
  })
}

describe('exec', () => {
  it('starts the wrapper detached under setsid, with cwd and env riding Vercel', async () => {
    const fake = fakeSandbox()
    await session(fake).exec(['claude', '-p', 'hi'], { cwd: '/repo', env: { CI: '1' } })

    const started = fake.detached[0]
    expect(started?.cmd).toBe('setsid')
    // `--wait` is why this is not a bare `setsid`: that forks and exits at once, and every turn
    // would report itself finished the moment it started.
    expect(started?.args?.slice(0, 3)).toEqual(['--wait', 'sh', '-c'])
    expect(started?.cwd).toBe('/repo')
    expect(started?.env).toEqual({ CI: '1' })
    // No `cd` and no `env` prologue — the fewer things the script says, the fewer there are for
    // a prompt to be mistaken for.
    expect(started?.args?.[3]).not.toContain('cd ')
  })

  it('records the command id and the session the command id belongs to', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    const written = JSON.parse(decode(fake.files.get(journalPaths(ROOT, handle.id).meta) ?? encode('')))

    expect(written.cmdId).toBe('cmd_1')
    expect(written.sessionId).toBe('ses_1')
  })

  it('verifies the journal root rather than trusting mkdir', async () => {
    const fake = fakeSandbox()
    fake.dirs.delete(ROOT)
    // A `mkdir` that reports success and creates nothing — which is the failure worth guarding
    // against, because a missing root fails *silently* afterwards: the wrapper's redirection
    // dies, the wrapped command never runs, and the caller learns only much later that the
    // transcript is empty. Only the `test -d` that follows says otherwise.
    const real = fake.sandbox.runCommand
    vi.spyOn(fake.sandbox, 'runCommand').mockImplementation((params => params.cmd === 'mkdir'
      ? Promise.resolve({
          cmdId: 'cmd_lie',
          exitCode: 0,
          startedAt: 0,
          cwd: '/vercel/sandbox',
          kill: async () => {},
          wait: async () => { throw new Error('unused') },
          stdout: async () => '',
          stderr: async () => '',
        })
      : real(params)) as typeof real)

    await expect(session(fake).exec(['claude'])).rejects.toThrow(/is not a directory/)
    expect(fake.detached).toHaveLength(0)
  })

  it('kills the group and the wrapper when the meta write fails, then reports', async () => {
    const fake = fakeSandbox()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fake.procs.set(4000, { cmdline: 'sh -c : \'p1\' ; printf', pgid: 4000 })
    fake.files.set(journalPaths(ROOT, 'p1').pgid, encode('4000'))
    const writeFiles = vi.spyOn(fake.sandbox, 'writeFiles').mockRejectedValue(new Error('disk full'))

    await expect(session(fake).exec(['claude'])).rejects.toThrow(/could not be written/)
    // A turn nobody can name is the duplicate-turn hazard in its purest form: no handle is
    // returned, `getProcess` finds no meta, and `listProcesses` screens on the meta file.
    expect(fake.procs.has(4000)).toBe(false)
    // The `Command.kill` backstop covers the window where `.pgid` has not landed yet.
    expect(fake.commands.get('cmd_1')).toMatchObject({ killed: ['SIGKILL'] })
    writeFiles.mockRestore()
    warn.mockRestore()
  })

  it('keeps the filesystem root a root when normalizing journalRoot', async () => {
    const fake = fakeSandbox()
    const handle = await createVercelSession(fake.sandbox, {
      journalRoot: '/',
      newProcessId: () => 'p1',
      now: () => AT,
      pollIntervalMs: 0,
    }).exec(['claude'])

    // Stripping the trailing slash from `/` leaves the empty string, which `createJournalIo`
    // interpolates straight into `mkdir -p -- ''` and `test -d ''` — so the session could
    // neither exec nor discover, while `journalPaths('/')` is explicitly supported.
    expect(fake.ran).toContainEqual({ cmd: 'mkdir', args: ['-p', '--', '/'] })
    expect(fake.files.has(journalPaths('/', handle.id).meta)).toBe(true)
  })
})

describe('statusOf', () => {
  it('settles on an exit code Vercel recorded, whatever the group says', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    startProcess(fake, handle.id)
    // Still live, and Vercel says it ended: the API's own account of the command it started is
    // the one reading the turn cannot forge.
    endProcess(fake, handle.id, 7, true)
    startProcess(fake, handle.id)

    expect(await handle.status()).toMatchObject({ state: 'exited', exit: { code: 7 } })
  })

  it('reports a live group as running and carries the journalled pid', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    startProcess(fake, handle.id, { pid: 4000, childPid: 4001 })

    expect(await handle.status()).toMatchObject({ state: 'running', pid: 4001, command: ['claude'] })
  })

  it('reports an unreadable probe as running, on purpose', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    startProcess(fake, handle.id)
    fake.failing.add('/proc/')

    // The two mistakes are not symmetric: guessing "running" wrong costs one more re-check,
    // guessing "dead" wrong starts a second `claude` in the same checkout.
    expect(await handle.status()).toMatchObject({ state: 'running' })
  })

  it('does not settle on an exit record forged while the group is alive', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    startProcess(fake, handle.id)
    forgeExit(fake, handle.id, 0)

    expect(await handle.status()).toMatchObject({ state: 'running' })
  })

  it('accepts a journalled exit once the group is gone, with the timeout marker', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    startProcess(fake, handle.id)
    fake.files.set(journalPaths(ROOT, handle.id).timeout, encode('t'))
    endProcess(fake, handle.id, 143)

    expect(await handle.status()).toMatchObject({
      state: 'exited',
      exit: { code: 143, timedOut: true },
      endedAt: AT,
    })
  })

  it('reports a wrapper that died before recording $? as no_exit_record', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    startProcess(fake, handle.id)
    killWrapperOnly(fake, handle.id)

    expect(await handle.status()).toMatchObject({
      state: 'error',
      error: { code: 'no_exit_record', message: 'process is not running and journalled no exit code' },
    })
  })
})

describe('getProcess and listProcesses', () => {
  it('answers from the journal without starting anything', async () => {
    const fake = fakeSandbox()
    const live = session(fake)
    const handle = await live.exec(['claude'])
    startProcess(fake, handle.id)
    const before = fake.detached.length

    expect((await live.getProcess(handle.id))?.id).toBe(handle.id)
    expect(fake.detached).toHaveLength(before)
  })

  it('hands back a handle for a finished turn whose meta is gone', async () => {
    const fake = fakeSandbox()
    const live = session(fake)
    const handle = await live.exec(['claude'])
    startProcess(fake, handle.id)
    endProcess(fake, handle.id, 0)
    // What a turn can do, and what `settleRun` then replays through this lookup: `null` here
    // would record a turn that succeeded as one whose logs could not be read.
    fake.files.delete(journalPaths(ROOT, handle.id).meta)

    expect(await live.getProcess(handle.id)).not.toBeNull()
  })

  it('answers null only when the journal holds nothing at all', async () => {
    const fake = fakeSandbox()
    expect(await session(fake).getProcess('p9')).toBeNull()
    expect(await session(fake).getProcess('../escape')).toBeNull()
  })

  it('screens foreign filenames and half-published exit records', async () => {
    const fake = fakeSandbox()
    const live = session(fake, ['p1'])
    const handle = await live.exec(['claude'])
    startProcess(fake, handle.id)
    fake.files.set(`${ROOT}/2026-08-24.log`, encode('a benign visitor'))
    fake.files.set(`${ROOT}/p2.exit.pending`, encode('0'))

    expect((await live.listProcesses()).map(status => status.id)).toEqual(['p1'])
  })

  it('answers an empty list for a missing root and throws on an unreadable one', async () => {
    const empty = fakeSandbox()
    empty.dirs.delete(ROOT)
    expect(await session(empty).listProcesses()).toEqual([])

    const blind = fakeSandbox()
    blind.failing.add('ls')
    // Ambiguity is never an absence here: `[]` is read as "no turn is running in this checkout".
    await expect(session(blind).listProcesses()).rejects.toThrow()
  })
})

describe('destroy', () => {
  it('reaps the groups it knows about before deleting the sandbox', async () => {
    const fake = fakeSandbox()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const live = session(fake)
    const handle = await live.exec(['claude'])
    startProcess(fake, handle.id, { pid: 4000, childPid: 4001 })

    await live.destroy()

    expect(fake.procs.size).toBe(0)
    expect(fake.deleted).toBe(true)
    warn.mockRestore()
  })

  it('refuses to report success when a process outlived its kill and the delete failed', async () => {
    const fake = fakeSandbox()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const live = session(fake)
    const handle = await live.exec(['claude'])
    startProcess(fake, handle.id, { pid: 4000, childPid: 4001 })
    fake.stubborn.add(4001)
    vi.spyOn(fake.sandbox, 'delete').mockRejectedValue(new Error('gateway timeout'))

    await expect(live.destroy()).rejects.toThrow(/could not be confirmed dead/)
    warn.mockRestore()
  })
})
