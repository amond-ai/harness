import { SANDBOX_PORT_HEADER } from '@amond-ai/harness-transport-cloudflare'
import { describe, expect, it, vi } from 'vitest'
import { endProcess, fakeContainer, fakeSandbox } from './cloudflare.fixtures'
import { HarnessSandbox } from './durable-object'
import { RUN } from './process-scripts'

vi.mock('cloudflare:workers', async () => (await import('./fake-workers')).workersModule)
vi.mock('@cloudflare/sandbox', async () => (await import('./fake-workers')).sandboxModule)

function bridgeRequest(port: string | null): Request {
  const headers = new Headers({ 'x-trace': 'kept' })
  if (port !== null) {
    headers.set(SANDBOX_PORT_HEADER, port)
  }
  return new Request('http://localhost:3001/bridge?agent_bridge_token=t0ken', { headers })
}

describe('fetch', () => {
  it('forwards to the named port with the port header stripped and the query kept', async () => {
    const container = fakeContainer()
    container.running = true
    const forwarded: Request[] = []
    container.getTcpPort.mockReturnValue({
      fetch: async (request: Request) => {
        forwarded.push(request)
        return new Response('from the container')
      },
    })
    const { sandbox } = fakeSandbox(container)

    const response = await sandbox.fetch(bridgeRequest('3001'))

    expect(await response.text()).toBe('from the container')
    expect(container.getTcpPort).toHaveBeenCalledWith(3001)
    expect(forwarded[0]!.headers.has(SANDBOX_PORT_HEADER)).toBe(false)
    expect(forwarded[0]!.headers.get('x-trace')).toBe('kept')
    expect(new URL(forwarded[0]!.url).searchParams.get('agent_bridge_token')).toBe('t0ken')
  })

  it('answers 503 without starting a container when none runs', async () => {
    const { container, sandbox } = fakeSandbox()

    expect((await sandbox.fetch(bridgeRequest('3001'))).status).toBe(503)
    expect(container.start).not.toHaveBeenCalled()
  })

  it('answers 503 when nothing listens on the port, and 400 without a port', async () => {
    const container = fakeContainer()
    container.running = true
    container.getTcpPort.mockReturnValue({ fetch: async () => Promise.reject(new Error('refused')) })
    const { sandbox } = fakeSandbox(container)

    expect((await sandbox.fetch(bridgeRequest('3001'))).status).toBe(503)
    expect((await sandbox.fetch(bridgeRequest(null))).status).toBe(400)
  })
})

describe('container lifecycle', () => {
  it('re-sets the inactivity timeout when a restarted object finds its container running', () => {
    const container = fakeContainer()
    container.running = true
    fakeSandbox(container)

    expect(container.setInactivityTimeout).toHaveBeenCalledWith(5 * 60 * 1000)
  })

  it('runs setupContainer again before fetch forwards when a restarted object finds its container running', async () => {
    const calls: string[] = []
    class Recording extends HarnessSandbox {
      protected override async setupContainer(_container: Container, fresh: boolean): Promise<void> {
        calls.push(`setup fresh=${String(fresh)}`)
      }
    }
    const container = fakeContainer()
    container.running = true
    container.getTcpPort.mockReturnValue({
      fetch: async () => {
        calls.push('forward')
        return new Response('ok')
      },
    })
    const { sandbox, ready } = fakeSandbox(container, Recording)

    await ready
    await sandbox.fetch(bridgeRequest('3001'))

    expect(calls).toEqual(['setup fresh=false', 'forward'])
    expect(container.start).not.toHaveBeenCalled()
  })

  it('refuses to start without a sandbox image rather than starting something else', async () => {
    const container = fakeContainer()
    container.images = {}
    const { session } = fakeSandbox(container)

    await expect(session().exec(['claude'])).rejects.toThrow(/images\.sandbox/)
    expect(container.start).not.toHaveBeenCalled()
  })
})

describe('startProcess', () => {
  it('tracks the process before launching it, and forgets it when the launch fails', async () => {
    const { container, storage, session } = fakeSandbox()
    const exec = container.exec
    let keysAtLaunch: string[] = []
    let alarmAtLaunch: number | null = null
    container.exec = async (argv, options) => {
      if (argv[2] === RUN) {
        keysAtLaunch = [...storage.data.keys()]
        alarmAtLaunch = storage.alarm
        throw new Error('exec failed')
      }
      return exec(argv, options)
    }

    await expect(session().exec(['claude'])).rejects.toThrow('exec failed')
    expect(keysAtLaunch).toEqual(['process:run-1'])
    expect(alarmAtLaunch).not.toBeNull()
    expect(storage.data.has('process:run-1')).toBe(false)
    expect(container.processes.size).toBe(0)
  })
})

describe('alarm', () => {
  it('re-arms while a process runs and forgets one that has ended', async () => {
    const { container, storage, sandbox, session } = fakeSandbox()
    const s = session()
    await s.exec(['claude'])
    await s.exec(['git'])
    endProcess(container, 'run-2', 0)
    storage.alarm = null

    await sandbox.alarm()

    expect([...storage.data.keys()]).toEqual(['process:run-1'])
    expect(storage.alarm).not.toBeNull()
    endProcess(container, 'run-1', 0)
    storage.alarm = null
    await sandbox.alarm()
    expect(storage.data.size).toBe(0)
    expect(storage.alarm).toBeNull()
  })
})
