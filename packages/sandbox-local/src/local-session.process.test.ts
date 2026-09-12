import { describe, expect, it } from 'vitest'
import { journalledScript, journalPaths, parseProcessRecord, serializeProcessRecord } from './journal'
import { AT, decode, fakeHost, sessionOver, STATE, WORK } from './local.fixtures'

const PATHS = journalPaths(STATE, 'p1')

describe('exec', () => {
  it('spawns the journal wrapper in the sandbox\'s own directory', async () => {
    const fake = fakeHost()
    const session = sessionOver(fake)
    const handle = await session.exec(['claude', '-p'], { env: { ANTHROPIC_API_KEY: 'k' } })

    expect(handle.id).toBe('p1')
    expect(fake.spawned).toEqual([{
      script: journalledScript(['claude', '-p'], PATHS),
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
    fake.place({
      pid: 4711,
      command: `/bin/sh -c ${journalledScript(['claude', '-p'], PATHS)}`,
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
    fake.place({ pid: 4711, command: `/bin/sh -c ${journalledScript(['claude', '-p'], PATHS)}` })
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
    fake.place({ pid: 4711, command: `/bin/sh -c ${journalledScript(['claude'], journalPaths(STATE, 'live'))}` })

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
