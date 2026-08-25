import type { E2bSandboxLike } from './e2b-session'
import type { E2bSandboxApi } from './provider'
import { describe, expect, it } from 'bun:test'
import { createE2bProvider } from './provider'

function stubSandbox(sandboxId: string, killed: string[] = []): E2bSandboxLike {
  return {
    sandboxId,
    commands: {
      run: async () => ({ pid: 1, wait: async () => ({ exitCode: 0 }) }),
      list: async () => [],
      kill: async () => true,
    },
    files: {
      read: ((_path: string, opts: { format: 'bytes' | 'stream' }) =>
        Promise.resolve(opts.format === 'stream'
          ? new ReadableStream<Uint8Array>({ start: controller => controller.close() })
          : new Uint8Array())) as E2bSandboxLike['files']['read'],
      write: async () => undefined,
      exists: async () => true,
      list: async () => [],
      makeDir: async () => true,
    },
    setTimeout: async () => {},
    kill: async () => {
      killed.push(sandboxId)
      return true
    },
  }
}

interface Calls {
  created: { template: string, opts: Record<string, unknown> }[]
  connected: string[]
  listed: Record<string, string>[]
  killed: string[]
}

function fakeApi(existing: Record<string, string> = {}): { api: E2bSandboxApi, calls: Calls } {
  const calls: Calls = { created: [], connected: [], listed: [], killed: [] }
  const api: E2bSandboxApi = {
    create: async (template, opts) => {
      calls.created.push({ template, opts: opts as Record<string, unknown> })
      return stubSandbox('sbx-new', calls.killed)
    },
    connect: async (sandboxId) => {
      calls.connected.push(sandboxId)
      return stubSandbox(sandboxId, calls.killed)
    },
    list: async (query) => {
      calls.listed.push(query)
      const match = existing[query.pleaseSandboxId ?? '']
      return match ? [{ sandboxId: match }] : []
    },
  }
  return { api, calls }
}

describe('createE2bProvider', () => {
  it('identifies its backend', () => {
    expect(createE2bProvider({ api: fakeApi().api }).backend).toBe('e2b')
  })

  it('acquires nothing until the session is actually used', () => {
    const { api, calls } = fakeApi()
    createE2bProvider({ api }).session('run-42')
    expect(calls).toEqual({ created: [], connected: [], listed: [], killed: [] })
  })

  /**
   * `RunAgent.settle()` releases the sandbox from a `finally`, so this also runs for a run
   * refused before it touched one — and it runs on a different instance from the workflow
   * that started the turn, so an unacquired session does not imply an absent sandbox.
   * Creating one to kill it and skipping the kill are both wrong; connecting is not.
   */
  it('kills the sandbox a previous step left behind without acquiring it first', async () => {
    const { api, calls } = fakeApi({ 'run-42': 'sbx-existing' })
    await createE2bProvider({ api }).session('run-42').destroy()

    expect(calls.created).toEqual([])
    expect(calls.killed).toEqual(['sbx-existing'])
  })

  it('creates nothing when releasing a session whose sandbox never existed', async () => {
    const { api, calls } = fakeApi()
    await createE2bProvider({ api }).session('run-42').destroy()

    expect(calls.created).toEqual([])
    expect(calls.killed).toEqual([])
  })

  it('kills the sandbox it already acquired without listing for it again', async () => {
    const { api, calls } = fakeApi()
    const session = createE2bProvider({ api }).session('run-42')
    await session.exists('/')
    await session.destroy()

    expect(calls.created).toHaveLength(1)
    expect(calls.listed).toHaveLength(1)
    expect(calls.killed).toEqual(['sbx-new'])
  })

  it('creates a sandbox tagged with the contract id when none exists', async () => {
    const { api, calls } = fakeApi()
    // Deliberately not `claude`, which is also `DEFAULT_TEMPLATE`: a provider that dropped
    // the option and fell back to the default would satisfy an assertion made against it.
    await createE2bProvider({ api, template: 'agent-please-e2b' }).session('run-42').exists('/')

    expect(calls.connected).toEqual([])
    expect(calls.created).toHaveLength(1)
    expect(calls.created[0].template).toBe('agent-please-e2b')
    expect(calls.created[0].opts.metadata).toEqual({ pleaseSandboxId: 'run-42' })
  })

  it('reattaches to the sandbox a previous step left behind', async () => {
    const { api, calls } = fakeApi({ 'run-42': 'sbx-existing' })
    await createE2bProvider({ api }).session('run-42').exists('/')

    expect(calls.connected).toEqual(['sbx-existing'])
    expect(calls.created).toEqual([])
  })

  it('acquires once per session, however many calls it serves', async () => {
    const { api, calls } = fakeApi()
    const session = createE2bProvider({ api }).session('run-42')
    await session.exists('/')
    await session.exists('/other')
    await session.listProcesses()

    expect(calls.created).toHaveLength(1)
  })

  it('shares one acquisition between calls that race the first one', async () => {
    // Awaiting the calls in sequence only proves an already-resolved promise is reused. The
    // case that matters is two in flight at once, which is what would create two sandboxes
    // for one id if the resolved session — rather than the pending promise — were memoised.
    const { api, calls } = fakeApi()
    const session = createE2bProvider({ api }).session('run-42')
    await Promise.all([session.exists('/'), session.exists('/other'), session.listProcesses()])

    expect(calls.created).toHaveLength(1)
    expect(calls.listed).toHaveLength(1)
  })

  it('retries the acquisition after one that failed, instead of replaying its error', async () => {
    // `prepare-sandbox` is retried (`PREPARE_RETRIES`), and a retry that never reaches e2b
    // cannot recover from the transient error it is retrying for.
    let attempts = 0
    const { api, calls } = fakeApi()
    const failing: E2bSandboxApi = {
      ...api,
      list: async (query) => {
        attempts++
        if (attempts === 1) {
          throw new Error('e2b api unavailable')
        }
        return api.list(query)
      },
    }
    const session = createE2bProvider({ api: failing }).session('run-42')

    await expect(session.exists('/')).rejects.toThrow('e2b api unavailable')
    await session.exists('/')

    expect(attempts).toBe(2)
    expect(calls.created).toHaveLength(1)
  })

  it('reuses one sandbox across repeated session() calls for the same id', async () => {
    // The run workflow calls `this.sandbox(id)` once per step, so a provider that minted a
    // fresh session each time would list-and-connect on every step.
    const { api, calls } = fakeApi()
    const provider = createE2bProvider({ api })
    await provider.session('run-42').exists('/')
    await provider.session('run-42').exists('/again')

    expect(calls.created).toHaveLength(1)
  })

  it('gives separate sandbox ids separate sessions', async () => {
    const { api, calls } = fakeApi()
    const provider = createE2bProvider({ api })
    await provider.session('run-1').exists('/')
    await provider.session('run-2').exists('/')

    expect(calls.created).toHaveLength(2)
    expect(calls.listed.map(query => query.pleaseSandboxId)).toEqual(['run-1', 'run-2'])
  })

  it('forwards the sandbox environment and lifetime to create', async () => {
    const { api, calls } = fakeApi()
    await createE2bProvider({
      api,
      envs: { ANTHROPIC_API_KEY: 'k' },
      timeoutMs: 3_600_000,
    }).session('run-42').exists('/')

    expect(calls.created[0].opts.envs).toEqual({ ANTHROPIC_API_KEY: 'k' })
    expect(calls.created[0].opts.timeoutMs).toBe(3_600_000)
  })
})
