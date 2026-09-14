import type { VercelSandboxApi } from './vercel-api'
import type { VercelSandboxLike } from './vercel-surface'
import { describe, expect, it } from 'vitest'
import { createVercelProvider, sandboxNameFor } from './provider'
import { fakeSandbox, ROOT } from './vercel-sandbox.fake'
import { startProcess } from './vercel-session.fixtures'

interface FakeApi {
  api: VercelSandboxApi
  /** Names `getOrCreate` was asked for, and nothing else — the provider passes no create params. */
  created: string[]
  got: string[]
  /** Sandboxes Vercel holds, keyed by name. An absent name is a 404, not a failure. */
  held: Map<string, VercelSandboxLike>
}

function fakeApi(held: Map<string, VercelSandboxLike> = new Map()): FakeApi {
  const created: string[] = []
  const got: string[] = []
  return {
    created,
    got,
    held,
    api: {
      getOrCreate: async (name) => {
        created.push(name)
        const existing = held.get(name)
        if (existing) {
          return existing
        }
        const made = fakeSandbox().sandbox
        held.set(name, made)
        return made
      },
      get: async (name) => {
        got.push(name)
        return held.get(name)
      },
    },
  }
}

describe('sandboxNameFor', () => {
  it('maps an id that is already a DNS label onto itself, prefix and all', () => {
    expect(sandboxNameFor('run-abc123')).toBe('run-abc123')
    expect(sandboxNameFor('run-abc123', 'ci-')).toBe('ci-run-abc123')
  })

  it('refuses rather than normalising an id that is not one', () => {
    // A hash or a slug would defer the failure to a collision in production, where two ids
    // sharing one name is two runs sharing one sandbox. The refusal names the id and the rule.
    for (const bad of ['Run_ABC', 'run abc', '-leading', 'trailing-', '', 'a'.repeat(64)]) {
      expect(() => sandboxNameFor(bad)).toThrow(/DNS label/)
    }
  })
})

describe('acquisition', () => {
  it('shares one acquisition between concurrent first calls', async () => {
    const fake = fakeApi()
    const provider = createVercelProvider({ api: fake.api, stateRoot: ROOT })
    const session = provider.session('run-1')

    await Promise.all([session.exists('/tmp'), session.exists('/tmp'), provider.portEndpoint('run-1', 3000)])

    // Not two sandboxes — `getOrCreate` is atomic server-side — but two sandbox objects with
    // divergent `routes` caches, which is what the repair path reads.
    expect(fake.created).toEqual(['run-1'])
  })

  it('passes the name and nothing else, so no create params and no persistent', async () => {
    const fake = fakeApi()
    await createVercelProvider({ api: fake.api, stateRoot: ROOT }).session('run-1').exists('/tmp')

    expect(fake.created).toEqual(['run-1'])
  })

  it('hands back one session per id for the provider’s lifetime', () => {
    const provider = createVercelProvider({ api: fakeApi().api, stateRoot: ROOT })

    expect(provider.session('run-1')).toBe(provider.session('run-1'))
    expect(provider.session('run-1')).not.toBe(provider.session('run-2'))
  })

  it('routes the whole configured set in one update', async () => {
    const sandbox = fakeSandbox()
    const fake = fakeApi(new Map([['run-1', sandbox.sandbox]]))
    const provider = createVercelProvider({ api: fake.api, stateRoot: ROOT, ports: [3000, 3001, 3002] })

    await provider.session('run-1').exists('/tmp')

    // One call, not one per port. Routing them one at a time cost a cold sandbox three sequential
    // round trips — `[3000]`, `[3000, 3001]`, `[3000, 3001, 3002]` — on the path that already has
    // the worst latency, and split the 15-port ceiling check across calls so a set too large
    // could route some of itself before being refused.
    expect(sandbox.updates).toEqual([{ ports: [3000, 3001, 3002] }])
    expect((await provider.portEndpoint('run-1', 3001)).url).toContain('3001')
  })

  it('memoises the acquisition and not its failure', async () => {
    const fake = fakeApi()
    let failing = true
    const api: VercelSandboxApi = {
      getOrCreate: async (name) => {
        if (failing) {
          failing = false
          throw new Error('transient')
        }
        return fake.api.getOrCreate(name)
      },
      get: fake.api.get,
    }
    const session = createVercelProvider({ api, stateRoot: ROOT }).session('run-1')

    await expect(session.exists('/tmp')).rejects.toThrow('transient')
    // A rejected promise left memoised would outlive itself: every retry would replay the
    // original rejection instead of retrying.
    expect(await session.exists('/tmp')).toEqual({ exists: false })
  })
})

describe('discovery and release', () => {
  it('answers null and [] for a sandbox Vercel has never heard of, creating nothing', async () => {
    const fake = fakeApi()
    const session = createVercelProvider({ api: fake.api, stateRoot: ROOT }).session('run-1')

    expect(await session.getProcess('p1')).toBeNull()
    expect(await session.listProcesses()).toEqual([])
    // Recovery asking whether a stale turn is still there must not create a billable sandbox
    // merely to be told nothing is running in it.
    expect(fake.created).toEqual([])
    expect(fake.got).toEqual(['run-1', 'run-1'])
  })

  it('reads a sandbox Vercel still holds without creating one', async () => {
    const sandbox = fakeSandbox()
    const fake = fakeApi(new Map([['run-1', sandbox.sandbox]]))
    startProcess(sandbox, 'p1')
    const session = createVercelProvider({ api: fake.api, stateRoot: ROOT }).session('run-1')

    expect((await session.listProcesses()).map(status => status.id)).toEqual(['p1'])
    expect(fake.created).toEqual([])
  })

  it('deletes without acquiring, collecting orphan snapshots by default', async () => {
    const sandbox = fakeSandbox()
    const fake = fakeApi(new Map([['run-1', sandbox.sandbox]]))

    await createVercelProvider({ api: fake.api, stateRoot: ROOT }).session('run-1').destroy()

    expect(sandbox.deleted).toBe(true)
    expect(fake.created).toEqual([])
  })

  it('is a no-op when Vercel holds no sandbox for the id', async () => {
    const fake = fakeApi()

    await expect(createVercelProvider({ api: fake.api, stateRoot: ROOT }).session('run-1').destroy())
      .resolves
      .toBeUndefined()
    // Release must never be the thing that allocates: `settle()` runs it in a `finally`, for
    // runs that never touched a sandbox at all.
    expect(fake.created).toEqual([])
  })
})

describe('portEndpoint', () => {
  it('costs no update when the port is already routed', async () => {
    const sandbox = fakeSandbox()
    sandbox.routes.push({ url: 'https://sbx-1-3000.vercel.run', subdomain: 'sbx-1-3000', port: 3000 })
    const fake = fakeApi(new Map([['run-1', sandbox.sandbox]]))

    const endpoint = await createVercelProvider({ api: fake.api, stateRoot: ROOT }).portEndpoint('run-1', 3000)

    expect(endpoint.url).toBe('https://sbx-1-3000.vercel.run/')
    expect(sandbox.updates).toEqual([])
    // No preview token to hand back: a routed Vercel port is reachable by anyone who knows the
    // subdomain, and the bridge's own per-turn token is the only thing gating it.
    expect(endpoint.headers).toBeUndefined()
  })

  it('updates with the union of what is routed and what was asked for', async () => {
    const sandbox = fakeSandbox()
    sandbox.routes.push({ url: 'https://sbx-1-3000.vercel.run', subdomain: 'sbx-1-3000', port: 3000 })
    const fake = fakeApi(new Map([['run-1', sandbox.sandbox]]))

    await createVercelProvider({ api: fake.api, stateRoot: ROOT }).portEndpoint('run-1', 4100)

    // Vercel reads `ports` as the full desired list and deregisters everything omitted, so
    // sending `[4100]` alone would silently unroute the bridge this call is joining.
    expect(sandbox.updates).toEqual([{ ports: [3000, 4100] }])
  })

  it('refuses past the routed-port maximum rather than evicting someone else’s port', async () => {
    const sandbox = fakeSandbox()
    for (let port = 3000; port < 3015; port++) {
      sandbox.routes.push({ url: `https://sbx-1-${String(port)}.vercel.run`, subdomain: 'x', port })
    }
    const fake = fakeApi(new Map([['run-1', sandbox.sandbox]]))

    await expect(createVercelProvider({ api: fake.api, stateRoot: ROOT }).portEndpoint('run-1', 4100))
      .rejects
      .toThrow(/would need 16 routed ports of a maximum 15 \(already routed: 3000, /)
    expect(sandbox.updates).toEqual([])
  })

  it('counts the whole configured set against the ceiling, routing none of it', async () => {
    const sandbox = fakeSandbox()
    for (let port = 3000; port < 3014; port++) {
      sandbox.routes.push({ url: `https://sbx-1-${String(port)}.vercel.run`, subdomain: 'x', port })
    }
    const fake = fakeApi(new Map([['run-1', sandbox.sandbox]]))
    const provider = createVercelProvider({ api: fake.api, stateRoot: ROOT, ports: [4100, 4101, 4102] })

    // 14 routed and 3 configured is 17. Checked per port, the first would have succeeded and the
    // second failed, leaving the sandbox routed in a shape nobody asked for.
    await expect(provider.session('run-1').exists('/tmp'))
      .rejects
      .toThrow(/ports 4100, 4101, 4102 .* would need 17 routed ports/)
    expect(sandbox.updates).toEqual([])
  })

  it('throws naming the port when an update reports success and routes nothing', async () => {
    const sandbox = fakeSandbox()
    sandbox.unroutable.add(4100)
    const fake = fakeApi(new Map([['run-1', sandbox.sandbox]]))

    // Otherwise this surfaces much later as `domain()`'s bare `No route for port 4100`, from
    // somewhere that cannot explain it.
    await expect(createVercelProvider({ api: fake.api, stateRoot: ROOT }).portEndpoint('run-1', 4100))
      .rejects
      .toThrow(/did not route port 4100/)
  })

  it('speaks TLS for every scheme a caller can name, preserving the kind', async () => {
    const sandbox = fakeSandbox()
    sandbox.routes.push({ url: 'https://sbx-1-3000.vercel.run', subdomain: 'sbx-1-3000', port: 3000 })
    const provider = createVercelProvider({ api: fakeApi(new Map([['run-1', sandbox.sandbox]])).api, stateRoot: ROOT })

    // `*.vercel.run` is an HTTPS edge with nothing on plaintext behind it, so honouring `http`
    // or `ws` literally could only mint a URL that provably cannot be dialed.
    expect((await provider.portEndpoint('run-1', 3000, { protocol: 'http' })).url).toMatch(/^https:/)
    expect((await provider.portEndpoint('run-1', 3000, { protocol: 'https' })).url).toMatch(/^https:/)
    expect((await provider.portEndpoint('run-1', 3000, { protocol: 'ws' })).url).toMatch(/^wss:/)
    expect((await provider.portEndpoint('run-1', 3000, { protocol: 'wss' })).url).toMatch(/^wss:/)
    expect((await provider.portEndpoint('run-1', 3000)).url).toMatch(/^https:/)
  })
})

describe('the provider surface', () => {
  it('names its backend', () => {
    expect(createVercelProvider({ api: fakeApi().api }).backend).toBe('vercel')
  })
})
