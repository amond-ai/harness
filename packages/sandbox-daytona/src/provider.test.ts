import type { Fake } from './daytona-session.fixtures'
import type { DaytonaSandboxLike } from './daytona-surface'
import type { DaytonaSandboxApi } from './provider'
import { describe, expect, it } from 'vitest'
import { fakeSandbox, leapingClock } from './daytona-session.fixtures'
import { createDaytonaProvider, SANDBOX_ID_LABEL } from './provider'

interface FakeApi {
  api: DaytonaSandboxApi
  created: { snapshot?: string, labels?: Record<string, string>, autoStopInterval?: number }[]
  connected: string[]
  listed: { labels?: Record<string, string> }[]
  /** Daytona's own sandboxes, by the id it minted, with the label the provider set. */
  held: Map<string, { sandbox: DaytonaSandboxLike, fake: Fake, labels: Record<string, string> }>
  /** Held open until released, so a concurrent second acquisition is observable. */
  holdCreate: () => () => void
}

function fakeApi(): FakeApi {
  const held = new Map<string, { sandbox: DaytonaSandboxLike, fake: Fake, labels: Record<string, string> }>()
  const gate = { held: false, queue: [] as (() => void)[] }
  let next = 1
  const fake: FakeApi = {
    created: [],
    connected: [],
    listed: [],
    held,
    holdCreate: () => {
      gate.held = true
      return () => {
        gate.held = false
        for (const resume of gate.queue.splice(0)) {
          resume()
        }
      }
    },
    api: {
      create: async (params) => {
        fake.created.push(params)
        if (gate.held) {
          await new Promise<void>(resolve => gate.queue.push(resolve))
        }
        const id = `daytona-${next++}`
        const heldFake = fakeSandbox()
        held.set(id, { sandbox: heldFake.sandbox, fake: heldFake, labels: params.labels ?? {} })
        return heldFake.sandbox
      },
      connect: async (sandboxId) => {
        fake.connected.push(sandboxId)
        const found = held.get(sandboxId)
        if (!found) {
          throw new Error(`no sandbox ${sandboxId}`)
        }
        return found.sandbox
      },
      list: async (query) => {
        fake.listed.push(query)
        const wanted = query.labels?.[SANDBOX_ID_LABEL]
        return [...held]
          .filter(([, entry]) => entry.labels[SANDBOX_ID_LABEL] === wanted)
          .map(([id]) => ({ id }))
      },
    },
  }
  return fake
}

describe('createDaytonaProvider', () => {
  it('names the backend it is', () => {
    expect(createDaytonaProvider({ api: fakeApi().api }).backend).toBe('daytona')
  })

  /**
   * The contract addresses a sandbox by the id the orchestrator chose; Daytona mints its own. So
   * the orchestrator's id is a label, and a retried workflow step reattaches through the listing
   * rather than creating a second sandbox for the same run.
   */
  it('lists by label before creating, and reattaches on the next acquisition', async () => {
    const fake = fakeApi()
    const provider = createDaytonaProvider({ api: fake.api, snapshot: 'pleaseworks' })

    await provider.session('run-1').exists('/tmp')
    expect(fake.created).toEqual([{
      snapshot: 'pleaseworks',
      labels: { [SANDBOX_ID_LABEL]: 'run-1' },
      envVars: undefined,
      autoStopInterval: undefined,
    }])

    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    expect(fake.created).toHaveLength(1)
    expect(fake.connected).toEqual(['daytona-1'])
  })

  /**
   * Two first calls in flight at once would both list, both find nothing, and both create: two
   * sandboxes for one id, one of them orphaned with nothing left holding a handle to delete it.
   */
  it('shares one acquisition between concurrent first callers', async () => {
    const fake = fakeApi()
    const provider = createDaytonaProvider({ api: fake.api })
    const release = fake.holdCreate()

    const both = Promise.all([
      provider.session('run-1').exists('/tmp'),
      provider.portEndpoint('run-1', 3000),
    ])
    release()
    await both

    expect(fake.created).toHaveLength(1)
  })

  /**
   * `releaseSandbox()` runs in a `finally` on an instance that may never have acquired the
   * session, so release must connect without creating — otherwise it makes a sandbox purely to
   * delete it.
   */
  it('destroys without creating a sandbox to destroy', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('never-ran').destroy()

    expect(fake.created).toEqual([])
    expect(fake.connected).toEqual([])
  })

  it('destroys the sandbox a previous provider left behind', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')

    await createDaytonaProvider({ api: fake.api }).session('run-1').destroy()
    expect(fake.connected).toEqual(['daytona-1'])
  })

  /**
   * The label lookup matches a sandbox in every state so a retried step can reattach at all — and
   * that is what lets a stopped one through. An SDK turn parked on a human approval outlives the
   * auto-stop interval, so without this the resumed workflow issues `fs`/`process` calls at a
   * sandbox that is not running (Codex review, PR #463).
   */
  it('starts a reattached sandbox Daytona had stopped, and waits for it', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'stopped'
    held!.fake.woke.length = 0

    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')

    expect(held!.fake.woke).toEqual(['start', 'waitUntilStarted'])
    expect(held!.fake.state).toBe('started')
  })

  /** `start()` restores an archived sandbox, so auto-archive needs no separate branch. */
  it('starts a reattached sandbox Daytona had archived', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'archived'
    held!.fake.woke.length = 0

    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')

    expect(held!.fake.woke).toEqual(['start', 'waitUntilStarted'])
  })

  /**
   * A reattach can race the auto-stop timer into `stopping`, where the sandbox is neither usable
   * nor startable. Settled into `stopped` first, then woken like any other (Codex review, PR #463).
   */
  it('settles a reattached sandbox that is stopping, then starts it', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'stopping'
    held!.fake.woke.length = 0

    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')

    expect(held!.fake.woke).toEqual(['waitUntilStopped', 'start', 'waitUntilStarted'])
    expect(held!.fake.state).toBe('started')
  })

  /** Already on its way up: waited for, never started a second time. */
  it('waits for a reattached sandbox that is already starting, without starting it again', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'starting'
    held!.fake.woke.length = 0

    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')

    expect(held!.fake.woke).toEqual(['waitUntilStarted'])
  })

  /**
   * `paused` is a resting state like `stopped`, reached by `Sandbox.pause()` or by the 60-minute
   * auto-pause a pausing-capable class applies when no interval is given at create time. 0.211.2
   * ships no `resume`, so `start()` is the way back up (Codex review, PR #463).
   */
  it('starts a reattached sandbox Daytona had paused', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'paused'
    held!.fake.woke.length = 0

    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')

    expect(held!.fake.woke).toEqual(['start', 'waitUntilStarted'])
    expect(held!.fake.state).toBe('started')
  })

  /** `resuming` is coming up under its own power, exactly like `starting`. */
  it('waits for a reattached sandbox that is resuming, without starting it again', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'resuming'
    held!.fake.woke.length = 0

    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')

    expect(held!.fake.woke).toEqual(['waitUntilStarted'])
  })

  /**
   * `archiving` ends in `archived`, not `stopped`, so `waitUntilStopped` cannot settle it and the
   * SDK ships nothing else — it is re-read until it rests, then started like any archived sandbox
   * (#468). This is the window a container sandbox actually passes through, seven days after
   * auto-stop.
   */
  it('re-reads a reattached sandbox that is archiving until it rests, then starts it', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'archiving'
    held!.fake.refreshes = ['archiving', 'archived']
    held!.fake.woke.length = 0

    await createDaytonaProvider({ api: fake.api, pollIntervalMs: 1 }).session('run-1').exists('/tmp')

    expect(held!.fake.woke).toEqual(['refreshData', 'refreshData', 'start', 'waitUntilStarted'])
    expect(held!.fake.state).toBe('started')
  })

  /** The VM-class twin of `archiving`, settled the same way into `paused`. */
  it('re-reads a reattached sandbox that is pausing until it rests, then starts it', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'pausing'
    held!.fake.refreshes = ['paused']
    held!.fake.woke.length = 0

    await createDaytonaProvider({ api: fake.api, pollIntervalMs: 1 }).session('run-1').exists('/tmp')

    expect(held!.fake.woke).toEqual(['refreshData', 'start', 'waitUntilStarted'])
    expect(held!.fake.state).toBe('started')
  })

  /**
   * The state a settling sandbox rests in is read, not assumed — `Sandbox.pause()` itself counts
   * any exit from `pausing` as done. One that rests in `error` is left alone, exactly as an
   * `error` read directly would be, so Daytona's own error is the one the caller sees.
   */
  it('leaves a settling sandbox alone when it rests in a state that is not startable', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'archiving'
    held!.fake.refreshes = ['error']
    held!.fake.woke.length = 0

    await createDaytonaProvider({ api: fake.api, pollIntervalMs: 1 }).session('run-1').exists('/tmp')

    expect(held!.fake.woke).toEqual(['refreshData'])
    expect(held!.fake.state).toBe('error')
  })

  /** Bounded: a sandbox that never leaves `archiving` is reported by name, not started into. */
  it('gives up on a settling sandbox that never rests, naming the state it is stuck in', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'archiving'
    held!.fake.woke.length = 0
    const provider = createDaytonaProvider({
      api: fake.api,
      pollIntervalMs: 1,
      settleTimeoutMs: 100,
      monotonicNowMs: leapingClock(60),
    })

    await expect(provider.session('run-1').exists('/tmp')).rejects.toThrow(/still archiving after \d+ms/)

    expect(held!.fake.woke).toEqual(['refreshData'])
  })

  /**
   * The bound covers the round trip, not only the gaps between them. A `refreshData` that never
   * answers would otherwise hold the reattach open past `settleTimeoutMs`, because the loop reaches
   * its deadline check only once that call has returned.
   */
  it('gives up on a settling sandbox whose refresh never answers', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'archiving'
    held!.fake.stalls = true
    held!.fake.woke.length = 0
    const provider = createDaytonaProvider({ api: fake.api, pollIntervalMs: 1, settleTimeoutMs: 5 })

    await expect(provider.session('run-1').exists('/tmp')).rejects.toThrow(/still archiving after \d+ms/)

    expect(held!.fake.woke).toEqual(['refreshData'])
  })

  /** A running sandbox costs no round trip, which is the common case on every retried step. */
  it('leaves a running reattached sandbox alone', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.woke.length = 0

    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')

    expect(held!.fake.woke).toEqual([])
  })

  /**
   * Release must not pay for a boot nobody uses: `destroy()` reaches Daytona through
   * `openExisting`, which is deliberately outside the wake.
   */
  it('does not start a stopped sandbox merely to destroy it', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'stopped'
    held!.fake.woke.length = 0

    await createDaytonaProvider({ api: fake.api }).session('run-1').destroy()

    expect(held!.fake.woke).toEqual([])
    expect(held!.fake.deleted).toBe(true)
  })

  /**
   * `packages/sandbox/src/types.ts` gives `exists` the job of booting and calls
   * `getProcess`/`listProcesses` non-waking discovery that answers from cold state. Recovery asks
   * them about a run it may never have started, so acquiring here would create a billable sandbox
   * purely to be told nothing is running in it (Codex review, PR #463).
   */
  it('answers a discovery call without creating a sandbox', async () => {
    const fake = fakeApi()
    const session = createDaytonaProvider({ api: fake.api }).session('never-ran')

    expect(await session.getProcess('run-1-abc')).toBeNull()
    expect(await session.listProcesses()).toEqual([])
    expect(fake.created).toEqual([])
    expect(fake.connected).toEqual([])
  })

  /** The same call on a sandbox Daytona has stopped: read, never woken. */
  it('does not start a stopped sandbox to answer a discovery call', async () => {
    const fake = fakeApi()
    await createDaytonaProvider({ api: fake.api }).session('run-1').exists('/tmp')
    const held = fake.held.get('daytona-1')
    held!.fake.state = 'stopped'
    held!.fake.woke.length = 0

    expect(await createDaytonaProvider({ api: fake.api }).session('run-1').listProcesses()).toEqual([])
    expect(held!.fake.woke).toEqual([])
  })

  /** Not creating is not the same as not answering: an existing sandbox is still read. */
  it('reports the processes of a sandbox that already exists', async () => {
    const fake = fakeApi()
    const handle = await createDaytonaProvider({ api: fake.api }).session('run-1').exec(['sleep', '1'])

    const found = await createDaytonaProvider({ api: fake.api }).session('run-1').getProcess(handle.id)
    expect(found?.id).toBe(handle.id)
    expect((await createDaytonaProvider({ api: fake.api }).session('run-1').listProcesses()).map(p => p.id))
      .toEqual([handle.id])
  })

  it('carries the sandbox lifetime and environment through to create', async () => {
    const fake = fakeApi()
    const provider = createDaytonaProvider({
      api: fake.api,
      envVars: { ANTHROPIC_API_KEY: 'sk-not-real' },
      autoStopIntervalMinutes: 60,
    })
    await provider.session('run-1').exists('/tmp')

    expect(fake.created[0]).toMatchObject({
      envVars: { ANTHROPIC_API_KEY: 'sk-not-real' },
      autoStopInterval: 60,
    })
  })
})

describe('portEndpoint', () => {
  /**
   * A preview link is a public TLS endpoint, so honouring a plaintext scheme literally could only
   * hand back a URL that provably cannot be dialed. The *kind* is preserved — a socket stays a
   * socket, a request stays a request — because that is the part the caller knows.
   */
  it('answers over TLS whichever scheme kind the caller named', async () => {
    const provider = createDaytonaProvider({ api: fakeApi().api })
    const schemes = await Promise.all((['http', 'https', 'ws', 'wss', undefined] as const).map(
      async protocol => new URL((await provider.portEndpoint('run-1', 3000, { protocol })).url).protocol,
    ))

    expect(schemes).toEqual(['https:', 'https:', 'wss:', 'wss:', 'https:'])
  })

  it('carries the preview token in the header Daytona authenticates with', async () => {
    const provider = createDaytonaProvider({ api: fakeApi().api })
    const endpoint = await provider.portEndpoint('run-1', 3000)

    expect(endpoint.url).toBe('https://3000-sbx-1.proxy.daytona.works/')
    expect(endpoint.headers).toEqual({ 'x-daytona-preview-token': 'preview-token' })
  })

  /**
   * A WebSocket opened from a serverless runtime cannot set a request header, which is why
   * Daytona's own SDK appends the token as a query parameter instead — and that is exactly the
   * dial `@ai-sdk/harness-claude-code` makes.
   */
  it('also puts the token in the query string for a socket, which cannot carry headers', async () => {
    const provider = createDaytonaProvider({ api: fakeApi().api })
    const endpoint = await provider.portEndpoint('run-1', 3000, { protocol: 'ws' })

    expect(endpoint.url).toBe('wss://3000-sbx-1.proxy.daytona.works/?DAYTONA_SANDBOX_AUTH_KEY=preview-token')
    expect(endpoint.headers).toEqual({ 'x-daytona-preview-token': 'preview-token' })
  })
})
