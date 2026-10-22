import { describe, expect, it, vi } from 'vitest'
import { AT, endProcess, fakeSandbox, processOf } from './cloudflare.fixtures'
import { PROCESS_ROOT, RUN } from './process-scripts'

vi.mock('cloudflare:workers', async () => (await import('./fake-workers')).workersModule)
vi.mock('@cloudflare/sandbox', async () => (await import('./fake-workers')).sandboxModule)

describe('exec', () => {
  it('starts the container and resolves with a handle whose status names the recorded pid', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude', '-p', 'hi'], { cwd: '/workspace', env: { CI: '1' } })

    expect(container.start).toHaveBeenCalledWith({
      image: 'registry.example/sandbox:1',
      instance: 'standard-1',
      enableInternet: true,
    })
    expect(handle.id).toBe('run-1')
    expect(await handle.status()).toEqual({
      id: 'run-1',
      pid: 100,
      command: ['claude', '-p', 'hi'],
      cwd: '/workspace',
      startedAt: expect.any(String),
      state: 'running',
    })
    const run = container.execs.find(({ argv }) => argv[2] === RUN)!
    expect(run.argv.slice(4)).toEqual([`${PROCESS_ROOT}/run-1`, '', 'claude', '-p', 'hi'])
    expect(run.options).toMatchObject({ cwd: '/workspace', env: { CI: '1' }, stdout: 'ignore', stderr: 'ignore' })
  })

  it('arms the alarm that keeps the container alive while the process runs', async () => {
    const { storage, session } = fakeSandbox()
    await session().exec(['claude'])

    expect(storage.data.get('process:run-1')).toEqual(['claude'])
    expect(storage.alarm).not.toBeNull()
  })

  it('hands RUN the timeout in seconds for its watchdog', async () => {
    const { container, session } = fakeSandbox()
    await session().exec(['claude'], { timeout: 1_500 })

    expect(container.execs.find(({ argv }) => argv[2] === RUN)!.argv[5]).toBe('1.5')
  })
})

describe('discovery', () => {
  it('answers null and [] without starting a container when none runs', async () => {
    const { container, session } = fakeSandbox()

    expect(await session().getProcess('run-1')).toBeNull()
    expect(await session().listProcesses()).toEqual([])
    expect(container.start).not.toHaveBeenCalled()
    expect(container.execs).toEqual([])
  })

  it('reattaches a cold session to a process by id alone', async () => {
    const { session } = fakeSandbox()
    await session().exec(['claude'])

    const handle = await session().getProcess('run-1')
    expect(await handle?.status()).toMatchObject({ id: 'run-1', state: 'running', command: ['claude'] })
    expect(await session().getProcess('run-9')).toBeNull()
    expect(await session().getProcess('../etc')).toBeNull()
  })

  it('lists every process with its state', async () => {
    const { container, session } = fakeSandbox()
    const s = session()
    await s.exec(['claude'])
    await s.exec(['git', 'clone'])
    endProcess(container, 'run-2', 0)

    expect(await s.listProcesses()).toMatchObject([
      { id: 'run-1', state: 'running', command: ['claude'] },
      { id: 'run-2', state: 'exited', command: ['git', 'clone'], exit: { code: 0, timedOut: false } },
    ])
  })
})

describe('status', () => {
  it('maps exited, a timed-out exit, and lost onto the contract', async () => {
    const { container, session } = fakeSandbox()
    const s = session()
    const exited = await s.exec(['a'])
    const timedOut = await s.exec(['b'], { timeout: 10 })
    const lost = await s.exec(['c'])
    endProcess(container, 'run-1', 3)
    endProcess(container, 'run-2', 143, true)
    processOf(container, 'run-3').phase = 'lost'

    expect(await exited.status()).toMatchObject({ state: 'exited', exit: { code: 3, timedOut: false }, endedAt: AT })
    expect(await timedOut.status()).toMatchObject({ state: 'exited', exit: { code: 143, timedOut: true } })
    expect(await lost.status()).toMatchObject({ state: 'error', error: { code: 'no_exit_record' } })
  })

  it('passes a status above 128 through without claiming a signal', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    endProcess(container, 'run-1', 130)

    const status = await handle.status()
    expect(status.state === 'exited' && status.exit).toEqual({ code: 130, timedOut: false })
  })

  it('names a process whose meta.json the turn rewrote as unrecorded rather than dropping it', async () => {
    const { container, session } = fakeSandbox()
    await session().exec(['claude'])
    processOf(container, 'run-1').meta = 'not json'

    expect(await (await session().getProcess('run-1'))?.status()).toMatchObject({
      state: 'running',
      command: ['<unrecorded>'],
    })
  })
})

describe('kill', () => {
  it('sends a named signal to the process group by name', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    await handle.kill(2)

    expect(container.kills).toEqual([{ dir: `${PROCESS_ROOT}/run-1`, signal: 'INT' }])
  })

  it('sends SIGTERM without a signal, and treats an exited process as already killed', async () => {
    const { container, session } = fakeSandbox()
    const handle = await session().exec(['claude'])
    await handle.kill()
    endProcess(container, 'run-1', 143)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await handle.kill()

    expect(container.kills).toEqual([{ dir: `${PROCESS_ROOT}/run-1`, signal: 'TERM' }])
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reports a named signal it cannot deliver and sends nothing in its place', async () => {
    const { container, session } = fakeSandbox()
    container.runPhase = 'lost'
    const handle = await session().exec(['claude'])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await handle.kill(2)

    expect(container.kills).toEqual([])
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/signal 2 to 'run-1': no-pid/))
    warn.mockRestore()
  })
})

describe('destroy', () => {
  it('does not start a container when none runs, and forgets the processes', async () => {
    const { container, storage, session } = fakeSandbox()
    storage.data.set('process:run-1', ['claude'])
    await session().destroy()

    expect(container.start).not.toHaveBeenCalled()
    expect(container.destroy).not.toHaveBeenCalled()
    expect(storage.data.size).toBe(0)
    expect(storage.alarm).toBeNull()
  })

  it('stops a running container', async () => {
    const { container, session } = fakeSandbox()
    await session().exec(['claude'])
    await session().destroy()

    expect(container.destroy).toHaveBeenCalledOnce()
    expect(container.running).toBe(false)
  })
})
