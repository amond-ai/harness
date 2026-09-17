import { describe, expect, it } from 'vitest'
import { journalledScript, journalPaths, noncePath, parseProcessRecord, serializeProcessRecord } from './journal'
import { AT, decode, fakeHost, NONCE, sessionOver, STATE, WORK } from './local.fixtures'

const PATHS = journalPaths(STATE, 'p1')

describe('exec', () => {
  it('spawns the journal wrapper in the sandbox\'s own directory', async () => {
    const fake = fakeHost()
    const session = sessionOver(fake)
    const handle = await session.exec(['claude', '-p'], { env: { ANTHROPIC_API_KEY: 'k' } })

    expect(handle.id).toBe('p1')
    expect(fake.spawned).toEqual([{
      script: journalledScript(['claude', '-p'], PATHS, NONCE),
      cwd: WORK,
      // The base environment is layered under the caller's, not replaced by it: the `cli`
      // driver execs a `claude` the machine already has, and a spawn without PATH cannot.
      env: { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'k' },
    }])
  })

  it('resolves a caller\'s cwd inside the sandbox rather than on the machine', async () => {
    const fake = fakeHost()
    await sessionOver(fake).exec(['claude'], { cwd: '/home/user/repo' })
    expect(fake.spawned[0]?.cwd).toBe(`${WORK}/home/user/repo`)
  })

  it('records the pid together with the kernel\'s start time for it', async () => {
    const fake = fakeHost({ nextPid: 4711 })
    await sessionOver(fake).exec(['claude', '-p'])
    expect(parseProcessRecord(decode(fake.files.get(PATHS.meta)!))).toEqual({
      id: 'p1',
      pid: 4711,
      command: ['claude', '-p'],
      cwd: WORK,
      startedAt: AT,
      kernelStartedAt: 'start-4711',
    })
  })

  it('kills what it cannot name when the record will not write', async () => {
    // No handle is returned and discovery has nothing to find, so a surviving wrapper would be
    // a command writing to the checkout that nothing can stop. Better a failed exec.
    const fake = fakeHost({ nextPid: 4711 })
    fake.host.writeFile = async () => {
      throw new Error('disk full')
    }
    await expect(sessionOver(fake).exec(['claude', '-p'])).rejects.toThrow(/could not be written/)
    expect(fake.table.has(4711)).toBe(false)
  })

  it('says the wrapper survived when the kill of it was refused', async () => {
    // The worse half of the same failure, and it must not read as the better one: `signalGroup`
    // declines a leader it cannot verify, so the command is still running, still writing into
    // the working directory, and now has no record at all.
    const fake = fakeHost({ nextPid: 4711 })
    fake.host.writeFile = async () => {
      throw new Error('disk full')
    }
    fake.psWorks = false
    await expect(sessionOver(fake).exec(['claude', '-p'])).rejects.toThrow(/could not be confirmed killed/)
    expect(fake.table.has(4711)).toBe(true)
  })

  it('refuses to start when the working directory cannot be made', async () => {
    const fake = fakeHost()
    fake.host.mkdir = async () => {}
    await expect(sessionOver(fake).exec(['claude'])).rejects.toThrow(/could not be created/)
    expect(fake.spawned).toEqual([])
  })
})

describe('discovery', () => {
  it('answers about a process this session never started', async () => {
    // The case the whole backend is for: the app was quit mid-turn and relaunched.
    const fake = fakeHost()
    // The nonce file comes with the wrapper, because on a real machine it always does: it is
    // written by the `ensure()` that precedes the first spawn and removed only with the state
    // directory, so a state directory holding a wrapper's journals holds this too.
    fake.put(noncePath(STATE), NONCE)
    fake.place({
      pid: 4711,
      command: `/bin/sh -c ${journalledScript(['claude', '-p'], PATHS, NONCE)}`,
    })
    fake.put(PATHS.meta, serializeProcessRecord({
      id: 'p1',
      pid: 4711,
      command: ['claude', '-p'],
      startedAt: AT,
      kernelStartedAt: 'start-4711',
    }))

    const handle = await sessionOver(fake).getProcess('p1')
    await expect(handle?.status()).resolves.toMatchObject({ state: 'running', pid: 4711 })
  })

  it('finds a live process whose record is gone, rather than reporting a death', async () => {
    const fake = fakeHost()
    fake.put(noncePath(STATE), NONCE)
    fake.place({ pid: 4711, command: `/bin/sh -c ${journalledScript(['claude', '-p'], PATHS, NONCE)}` })
    const handle = await sessionOver(fake).getProcess('p1')
    await expect(handle?.status()).resolves.toMatchObject({ state: 'running', command: ['claude', '-p'] })
  })

  it('still finds a finished process through the transcript it left', async () => {
    // Neither the table nor a deleted record has it, and a replay of that transcript is how a
    // completed turn is read: `null` here would record a turn that succeeded as unreadable.
    const fake = fakeHost()
    fake.put(PATHS.stdout, 'the turn output')
    fake.put(PATHS.exit, '0')
    const handle = await sessionOver(fake).getProcess('p1')
    await expect(handle?.status()).resolves.toMatchObject({ state: 'exited', exit: { code: 0 } })
  })

  it('answers null for an id nothing knows about', async () => {
    await expect(sessionOver(fakeHost()).getProcess('p1')).resolves.toBeNull()
  })

  it('answers null for an id that could not name a journal file at all', async () => {
    // Discovery, not a path operation: a caller asking whether anything is there gets an
    // answer rather than an error about the shape of the id it asked with.
    await expect(sessionOver(fakeHost()).getProcess('../../etc/passwd')).resolves.toBeNull()
  })

  it('creates nothing while answering', async () => {
    const fake = fakeHost()
    const session = sessionOver(fake)
    await session.getProcess('p1')
    await session.listProcesses()
    expect([...fake.dirs]).toEqual(['/sandboxes'])
  })

  it('lists what has run beside what is running', async () => {
    const fake = fakeHost()
    fake.put(journalPaths(STATE, 'done').meta, serializeProcessRecord({
      id: 'done',
      pid: 4000,
      command: ['git', 'clone'],
      startedAt: AT,
      kernelStartedAt: 'start-4000',
    }))
    fake.put(journalPaths(STATE, 'done').exit, '0')
    fake.put(noncePath(STATE), NONCE)
    fake.place({ pid: 4711, command: `/bin/sh -c ${journalledScript(['claude'], journalPaths(STATE, 'live'), NONCE)}` })

    const listed = await sessionOver(fake).listProcesses()
    expect(listed.map(status => [status.id, status.state]).sort()).toEqual([
      ['done', 'exited'],
      ['live', 'running'],
    ])
  })
})

describe('destroy', () => {
  it('ends the processes, then removes only what the provider made', async () => {
    const fake = fakeHost({ nextPid: 4711 })
    fake.put(`${WORK}/repo/file.txt`, 'work')
    const session = sessionOver(fake)
    await session.exec(['claude', '-p'])

    await session.destroy()
    expect(fake.table.has(4711)).toBe(false)
    expect(fake.files.has(`${WORK}/repo/file.txt`)).toBe(false)
    expect(fake.files.has(journalPaths(STATE, 'p1').meta)).toBe(false)
    // The root and the state root are shared with every other sandbox — and with whatever the
    // consumer caches beside them. Nothing here may reach them.
    expect(fake.dirs.has('/sandboxes')).toBe(true)
  })

  it('removes nothing while a process it could not confirm killed may still be running', async () => {
    // The journal is the only record of that process, so deleting it is what turns an
    // unfinished destroy into an unrecoverable one: something is still writing into the
    // working directory and nothing is left to find it by.
    const fake = fakeHost({ nextPid: 4711 })
    fake.put(`${WORK}/repo/file.txt`, 'work')
    const session = sessionOver(fake)
    await session.exec(['claude', '-p'])
    fake.psWorks = false

    await expect(session.destroy()).rejects.toThrow(/could not be confirmed killed/)
    expect(fake.table.has(4711)).toBe(true)
    expect(fake.files.has(journalPaths(STATE, 'p1').meta)).toBe(true)
    expect(fake.files.has(`${WORK}/repo/file.txt`)).toBe(true)
  })

  it('removes nothing when the probe that refused the kill recovers and reports the process alive', async () => {
    // The group signal is declined whenever the host cannot verify the leader, and `ps` failing
    // for one call is exactly that. Reading only the unverifiable case as unconfirmed leaves
    // the worse one open: the very next probe succeeds, says `'live'`, and the journal of a
    // process that is demonstrably still running is deleted out from under it.
    const fake = fakeHost({ nextPid: 4711 })
    fake.put(`${WORK}/repo/file.txt`, 'work')
    let armed = false
    let refusals = 1
    const host = {
      ...fake.host,
      identify: async (pid: number) => (armed && refusals-- > 0 ? undefined : fake.host.identify(pid)),
    }
    const session = sessionOver(fake, { host })
    await session.exec(['claude', '-p'])
    armed = true

    await expect(session.destroy()).rejects.toThrow(/could not be confirmed killed/)
    expect(fake.table.has(4711)).toBe(true)
    expect(fake.files.has(journalPaths(STATE, 'p1').meta)).toBe(true)
    expect(fake.files.has(`${WORK}/repo/file.txt`)).toBe(true)
  })

  it('leaves a bystander that reproduces the wrapper marker alone', async () => {
    // What #4 was about: every part of a wrapper's command line except the nonce is public, so
    // a process carrying the shell, the opener, a process id and this state directory's paths
    // is something any process on the machine can be running. `destroy()` signals the group of
    // whatever the listing names, so claiming that row is not a mislabelling but a kill.
    const fake = fakeHost({ nextPid: 4711 })
    const session = sessionOver(fake)
    await session.exec(['claude', '-p'])
    fake.place({
      pid: 5000,
      command: `/bin/sh -c ${journalledScript(['claude', '-p'], journalPaths(STATE, 'p9'), 'someone-elses-nonce')}`,
    })

    await session.destroy()
    expect(fake.table.has(4711)).toBe(false)
    expect(fake.table.has(5000)).toBe(true)
  })

  it('leaves a working directory it was merely pointed at', async () => {
    const fake = fakeHost({ nextPid: 4711 })
    fake.put('/Users/me/project/file.txt', 'the user\'s own work')
    const session = sessionOver(fake, { paths: { work: '/Users/me/project', state: STATE, owned: false } })
    await session.exec(['claude', '-p'])

    await session.destroy()
    expect(fake.files.get('/Users/me/project/file.txt')).toBeDefined()
    expect(fake.table.has(4711)).toBe(false)
    expect(fake.files.has(journalPaths(STATE, 'p1').meta)).toBe(false)
  })
})
