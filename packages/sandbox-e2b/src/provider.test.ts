import type { E2bSandboxLike } from './e2b-session'
import type { E2bSandboxApi } from './provider'
import { describe, expect, it } from 'vitest'
import { encode, fakeSandbox, ROOT } from './e2b-session.fixtures'
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
    getHost: port => `${String(port)}-${sandboxId}.e2b.app`,
    setTimeout: async () => {},
    kill: async () => {
      killed.push(sandboxId)
      return true
    },
  }
}

/** A loser for `Promise.race`, so a test can assert something arrived *before* a deadline. */
function after<T>(ms: number, value: T): Promise<T> {
  return new Promise(resolve => setTimeout(resolve, ms, value))
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
      // Registered so a later `list` finds it, as e2b's really would. Without this the fake
      // makes every acquisition look like a first one, and a provider that created a second
      // sandbox for an id it had already created would go unnoticed.
      const tagged = (opts.metadata ?? {}).pleaseSandboxId
      if (tagged !== undefined) {
        existing[tagged] = 'sbx-new'
      }
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
    kill: async (sandboxId) => {
      calls.killed.push(sandboxId)
      return true
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
   * Creating one to kill it and skipping the kill are both wrong. So is connecting, on this
   * backend: `connect` resumes a paused sandbox, so the kill is issued by id instead and a
   * sandbox parked by auto-pause is deleted without being booted first (#464).
   */
  it('kills the sandbox a previous step left behind without acquiring or connecting to it', async () => {
    const { api, calls } = fakeApi({ 'run-42': 'sbx-existing' })
    await createE2bProvider({ api }).session('run-42').destroy()

    expect(calls.created).toEqual([])
    expect(calls.connected).toEqual([])
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

  /**
   * `packages/amond-ai/sandbox/src/types.ts` gives `exists` the job of booting and calls
   * `getProcess`/`listProcesses` non-waking discovery that answers from cold state. Recovery
   * asks them about a run it may never have started (`replay-turn.ts`), so acquiring here
   * would create a billable sandbox purely to be told nothing is running in it (#464).
   */
  it('answers a discovery call without creating a sandbox', async () => {
    const { api, calls } = fakeApi()
    const session = createE2bProvider({ api }).session('never-ran')

    expect(await session.getProcess('run-1-abc')).toBeNull()
    expect(await session.listProcesses()).toEqual([])
    expect(calls.created).toEqual([])
    expect(calls.connected).toEqual([])
  })

  /** Not creating is not the same as not answering: a sandbox e2b still holds is read. */
  it('reports the processes of a sandbox that already exists', async () => {
    const fake = fakeSandbox()
    const calls = { created: 0, connected: [] as string[] }
    const api: E2bSandboxApi = {
      create: async () => {
        calls.created++
        return fake.sandbox
      },
      connect: async (sandboxId) => {
        calls.connected.push(sandboxId)
        return fake.sandbox
      },
      list: async () => [{ sandboxId: 'sbx-1' }],
      kill: async () => true,
    }
    const options = { api, journalRoot: ROOT, newProcessId: () => 'run-1' }
    const handle = await createE2bProvider(options).session('run-a').exec(['sleep', '1'])

    // A fresh provider, as recovery on another Worker instance would be: nothing memoised.
    const found = await createE2bProvider(options).session('run-a').getProcess(handle.id)
    expect(found?.id).toBe(handle.id)
    expect((await createE2bProvider(options).session('run-a').listProcesses()).map(p => p.id))
      .toEqual([handle.id])
    expect(calls.created).toBe(0)
    expect(calls.connected).toEqual(['sbx-1', 'sbx-1', 'sbx-1'])
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

  /**
   * `lazySession`'s memo is per session object, so it cannot cover `portEndpoint`, which needs
   * the `E2bSandboxLike` itself and so reaches for the acquisition directly. Two first calls
   * in flight at once would each `list` (finding nothing) and each `create`, leaving a sandbox
   * nothing holds a handle to — and the run then talks to whichever of the two it got.
   */
  it('shares one acquisition between a first session use and a portEndpoint racing it', async () => {
    const { api, calls } = fakeApi()
    const provider = createE2bProvider({ api })
    await Promise.all([
      provider.session('run-42').exists('/'),
      provider.portEndpoint('run-42', 3001),
    ])

    expect(calls.created).toHaveLength(1)
    expect(calls.listed).toHaveLength(1)
  })

  it('shares one acquisition between concurrent first portEndpoint calls', async () => {
    const { api, calls } = fakeApi()
    const provider = createE2bProvider({ api })
    await Promise.all([
      provider.portEndpoint('run-42', 3001),
      provider.portEndpoint('run-42', 3002),
    ])

    expect(calls.created).toHaveLength(1)
  })

  /**
   * Shared only while in flight. A settled acquisition is not memoised at provider level —
   * `portEndpoint` is documented as costing a round trip, and a sandbox that was destroyed
   * must not be handed back by a memo that outlived it — so a later call lists again and
   * reattaches rather than creating a second sandbox.
   */
  it('reattaches rather than creating again once an acquisition has settled', async () => {
    const { api, calls } = fakeApi()
    const provider = createE2bProvider({ api })
    await provider.portEndpoint('run-42', 3001)
    await provider.portEndpoint('run-42', 3002)

    expect(calls.created).toHaveLength(1)
    expect(calls.listed).toHaveLength(2)
  })

  /**
   * e2b's ports are publicly routable, so the endpoint is a real address and not a tag the
   * way the Cloudflare backend's is — `getHost` answers the bare host e2b assigned that port.
   */
  it('answers with the host e2b assigned the port', async () => {
    const { api } = fakeApi({ 'run-42': 'sbx-existing' })
    const endpoint = await createE2bProvider({ api }).portEndpoint('run-42', 3001)

    expect(endpoint.url).toBe('https://3001-sbx-existing.e2b.app/')
  })

  /**
   * The scheme the caller names is honoured in kind but never in plaintext, and that override
   * is the behaviour these four rows pin. `@ai-sdk/harness-claude-code` asks for `'ws'`; an
   * e2b port answers nothing at all over plain HTTP, so the literal reading of that request
   * can only mint a URL that provably cannot be dialed — see the note on `portEndpoint`
   * itself for the measurement. Both directions are asserted, because a mapping that upgraded
   * everything to `wss` would pass a test that only checked `'ws'`.
   */
  it.each([
    ['ws', 'wss://3001-sbx-existing.e2b.app/'],
    ['wss', 'wss://3001-sbx-existing.e2b.app/'],
    ['http', 'https://3001-sbx-existing.e2b.app/'],
    ['https', 'https://3001-sbx-existing.e2b.app/'],
  ] as const)('answers a %s request over TLS, in the same kind', async (protocol, expected) => {
    const { api } = fakeApi({ 'run-42': 'sbx-existing' })
    const endpoint = await createE2bProvider({ api }).portEndpoint('run-42', 3001, { protocol })

    expect(endpoint.url).toBe(expected)
  })

  it('defaults to https when the caller names no scheme', async () => {
    const { api } = fakeApi({ 'run-42': 'sbx-existing' })
    const endpoint = await createE2bProvider({ api }).portEndpoint('run-42', 3001)

    expect(endpoint.url).toBe('https://3001-sbx-existing.e2b.app/')
  })

  /**
   * The id the caller names is the orchestrator's, and e2b has never heard of it — the host
   * can only be asked of the sandbox e2b actually holds. A provider that formatted the
   * contract id into a hostname would mint an address that resolves to nothing.
   */
  it('resolves the e2b sandbox rather than formatting the contract id into a host', async () => {
    const { api, calls } = fakeApi({ 'run-42': 'sbx-existing' })
    const endpoint = await createE2bProvider({ api }).portEndpoint('run-42', 3001)

    expect(calls.listed).toEqual([{ pleaseSandboxId: 'run-42' }])
    expect(calls.connected).toEqual(['sbx-existing'])
    expect(endpoint.url).not.toContain('run-42')
  })

  it('carries no headers, because e2b needs none to reach an open port', async () => {
    const { api } = fakeApi({ 'run-42': 'sbx-existing' })
    const endpoint = await createE2bProvider({ api }).portEndpoint('run-42', 3001)

    expect(endpoint.headers).toBeUndefined()
  })

  it('forwards the follow polling intervals to the sessions it opens', async () => {
    // `E2bProviderOptions` accepts both — it extends the session's options — so a deployment
    // that tunes the tail's cadence has every reason to expect them to arrive. They were not
    // in the forwarded object, which left the defaults in place and the tuning silently inert
    // for everyone who did not bypass the provider (codex review, PR #280).
    const fake = fakeSandbox()
    const provider = createE2bProvider({
      api: {
        create: async () => fake.sandbox,
        connect: async () => fake.sandbox,
        list: async () => [],
        kill: async () => true,
      },
      journalRoot: ROOT,
      newProcessId: () => 'run-1',
      followIntervalMs: 5,
      followLivenessIntervalMs: 5,
    })

    const handle = await provider.session('run-a').exec(['claude'])
    fake.files.set(`${ROOT}/run-1.out`, encode('starting\n'))
    const reader = (await handle.logs({ replay: true, follow: true })).getReader()
    expect((await reader.read()).value?.type).toBe('stdout')

    // The poll interval, measured on the gap it paces: at the 1s default nothing arrives
    // inside this window.
    fake.files.set(`${ROOT}/run-1.out`, encode('starting\nmore\n'))
    const served = reader.read().then(result => result.value?.type)
    expect(await Promise.race([served, after(150, 'slow')])).toBe('stdout')

    // And the liveness interval, on the probe it paces: the first probe has already been
    // spent, so a wrapper that dies now is only noticed once that interval comes round —
    // 5s away at the default, whatever the poll interval is.
    fake.live.delete(2054)
    const ended = reader.read().then(result => result.value?.type)
    expect(await Promise.race([ended, after(150, 'slow')])).toBe('terminal')
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
