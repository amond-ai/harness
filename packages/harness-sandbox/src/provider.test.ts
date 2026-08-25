import type { HarnessV1SandboxProvider } from '@ai-sdk/harness'
import { describe, expect, it } from 'bun:test'
import { createHarnessSandboxProvider } from './provider'
import { fakeSandboxProvider } from './sandbox.fixtures'

function provider(overrides: Partial<Parameters<typeof createHarnessSandboxProvider>[0]> = {}) {
  const { provider: sandboxes, state } = fakeSandboxProvider({ backend: 'fake' })
  return {
    provider: createHarnessSandboxProvider({
      sandboxes,
      defaultWorkingDirectory: '/workspace',
      ports: [3001],
      ...overrides,
    }),
    state,
  }
}

describe('createHarnessSandboxProvider', () => {
  it('satisfies the harness provider type', () => {
    const built = provider().provider satisfies HarnessV1SandboxProvider

    expect(built.specificationVersion).toBe('harness-sandbox-v1')
  })

  it('names itself after the backend it was handed', () => {
    expect(provider().provider.providerId).toBe('pleaseai-fake')
  })

  it('takes the provider id the caller chose', () => {
    expect(provider({ providerId: 'custom' }).provider.providerId).toBe('custom')
  })

  describe('sessions', () => {
    it('addresses the sandbox by the session id it was given', async () => {
      const { provider: p, state } = provider()
      const session = await p.createSession({ sessionId: 'run-42' })

      expect(session.id).toBe('run-42')
      expect(state.sessions).toEqual(['run-42'])
    })

    it('mints an id when the caller has none', async () => {
      const { provider: p } = provider({ newSessionId: () => 'minted-1' })
      const session = await p.createSession()

      expect(session.id).toBe('minted-1')
    })

    it('mints a distinct id per session by default', async () => {
      const { provider: p } = provider()
      const [first, second] = await Promise.all([p.createSession(), p.createSession()])

      expect(first.id).not.toBe(second.id)
    })

    it('reaches the same sandbox on resume as the id names', async () => {
      const { provider: p, state } = provider()
      const resumed = await p.resumeSession?.({ sessionId: 'run-42' })

      expect(resumed?.id).toBe('run-42')
      expect(state.sessions).toEqual(['run-42'])
    })

    it('hands the session the working directory and ports the caller declared', async () => {
      const { provider: p } = provider({ defaultWorkingDirectory: '/srv', ports: [9001, 9002] })
      const session = await p.createSession({ sessionId: 'run-42' })

      expect(session.defaultWorkingDirectory).toBe('/srv')
      expect(session.ports).toEqual([9001, 9002])
    })
  })

  describe('first create', () => {
    /**
     * The contract cannot say whether `session(id)` found a sandbox or minted one, so
     * `createSession` is taken as the fresh path and `resumeSession` as the returning one.
     * Dropping the callback would silently skip whatever setup the framework baked into it.
     */
    it('runs the framework one-time setup on create', async () => {
      const { provider: p, state } = provider()
      await p.createSession({
        sessionId: 'run-42',
        onFirstCreate: async session => void await session.writeTextFile({ path: '/setup', content: 'ran' }),
      })

      expect(new TextDecoder().decode(state.files('run-42').get('/setup'))).toBe('ran')
    })

    it('hands that setup the restricted view, not the infra surface', async () => {
      const { provider: p } = provider()
      let handed: Record<string, unknown> | undefined
      await p.createSession({
        sessionId: 'run-42',
        onFirstCreate: (session) => {
          handed = session as unknown as Record<string, unknown>
          return Promise.resolve()
        },
      })

      // First, that it ran at all. `handed` starts `undefined`, and `undefined?.stop` is also
      // `undefined`, so a provider that dropped the callback entirely satisfies every
      // assertion below — the strongest form of the regression passing as a green test.
      expect(handed).toBeDefined()
      expect(typeof handed?.writeTextFile).toBe('function')
      expect(handed?.stop).toBeUndefined()
      expect(handed?.destroy).toBeUndefined()
    })

    /**
     * Setup that fails has usually already started the sandbox — a write or a command is what
     * wakes a lazily-acquired backend. `createSession` then rejects with no handle ever
     * reaching the caller, so nothing is left that could reap it, and a paid Cloudflare or e2b
     * sandbox bills until its own timeout. Same shape as the kill guards in `process.ts`: the
     * teardown is best-effort and the original cause is rethrown unchanged.
     */
    it('destroys the sandbox when the one-time setup fails', async () => {
      const { provider: p, state } = provider()

      await expect(p.createSession({
        sessionId: 'run-42',
        onFirstCreate: async (session) => {
          await session.writeTextFile({ path: '/setup', content: 'half' })
          throw new Error('setup blew up')
        },
      })).rejects.toThrow('setup blew up')

      expect(state.destroys).toBe(1)
    })

    /**
     * The teardown is best-effort, and this is the assertion that says so: a `destroy()` that
     * fails too must not replace the setup failure with its own and send the caller after the
     * wrong call. `session.ts` clears its teardown latch on rejection, so the failed attempt
     * also leaves a later `destroy()` free to retry rather than replaying the rejection.
     */
    it('keeps the setup failure as the rejection when that teardown also fails', async () => {
      const { provider: sandboxes, state } = fakeSandboxProvider({ failingDestroys: 1 })
      const p = createHarnessSandboxProvider({
        sandboxes,
        defaultWorkingDirectory: '/workspace',
        ports: [3001],
      })

      await expect(p.createSession({
        sessionId: 'run-42',
        onFirstCreate: () => Promise.reject(new Error('setup blew up')),
      })).rejects.toThrow('setup blew up')

      expect(state.destroys).toBe(1)
    })

    /**
     * And a teardown that throws *synchronously* is best-effort too, which the rejecting case
     * above cannot say.
     *
     * `Promise.resolve(created.destroy()).catch(…)` evaluates its argument before
     * `Promise.resolve` is ever called, so a `destroy()` that throws instead of rejecting
     * escapes the handler and replaces the setup cause with its own — the exact harm this
     * guard exists to prevent, in the one shape it did not cover. The harness types
     * `destroy()` as `PromiseLike<void>`, which promises nothing about *when* it fails
     * (cubic review, PR #268).
     */
    it('keeps the setup failure as the rejection when that teardown throws synchronously', async () => {
      const { provider: sandboxes, state } = fakeSandboxProvider({
        destroyThrows: new Error('teardown threw'),
      })
      const p = createHarnessSandboxProvider({
        sandboxes,
        defaultWorkingDirectory: '/workspace',
        ports: [3001],
      })

      await expect(p.createSession({
        sessionId: 'run-42',
        onFirstCreate: () => Promise.reject(new Error('setup blew up')),
      })).rejects.toThrow('setup blew up')

      // The rethrow is only half of it: a guard that skipped the teardown entirely would
      // rejects.toThrow the same cause and leave the sandbox billing.
      expect(state.destroys).toBe(1)
    })

    /** Setup that succeeded is the whole point of the session — it must survive the call. */
    it('leaves the sandbox alone when the setup succeeds', async () => {
      const { provider: p, state } = provider()
      await p.createSession({
        sessionId: 'run-42',
        onFirstCreate: () => Promise.resolve(),
      })

      expect(state.destroys).toBe(0)
    })
  })

  /**
   * Omitted the way the harness's own just-bash provider omits them: the contract has no
   * network-policy, port-registration or request-transformation primitive to answer them
   * with. The consequence is real and not a shrug — the claude-code adapter calls
   * `addRequestTransformations?.()` and falls back to legacy credential forwarding when it
   * is absent, so credentials reach a session here the old way.
   */
  it('omits every capability the contract cannot express', async () => {
    const { provider: p } = provider()
    const session = await p.createSession({ sessionId: 'run-42' })

    expect(session.setNetworkPolicy).toBeUndefined()
    expect(session.setPorts).toBeUndefined()
    expect(session.setRequestTransformations).toBeUndefined()
    expect(session.addRequestTransformations).toBeUndefined()
  })
})

/**
 * A synchronous throw from a promise-returning method is a different failure than a rejection.
 *
 * `SandboxProvider.session` is synchronous by contract, and a backend refuses there — an id
 * that does not name a sandbox, a provider already torn down. `resumeSession` and
 * `createSession` are both `Promise`-returning, so a caller writes one error path:
 * `provider.resumeSession(…).catch(…)`, or an `await` inside a `try`. A method that throws
 * *before* returning a promise escapes the `.catch` form entirely — there is no promise for it
 * to attach to — and the throw lands in whatever called the resume instead. `createSession` is
 * `async` and so cannot do this; the two are asserted together because the pair is the point.
 */
describe('a backend that refuses synchronously', () => {
  function refusing(): HarnessV1SandboxProvider {
    const { provider: sandboxes } = fakeSandboxProvider()
    return createHarnessSandboxProvider({
      sandboxes: {
        ...sandboxes,
        session: (sandboxId) => {
          throw new Error(`no sandbox named ${sandboxId}`)
        },
      },
      defaultWorkingDirectory: '/workspace',
      ports: [3001],
    })
  }

  /**
   * `Promise.resolve(…).catch(…)` rather than `.catch` on the call: the harness types both
   * returns as `PromiseLike`, which has no `catch`, and the handler is only here to keep the
   * rejection from surfacing as an unhandled one. It wraps the call's *result*, so a throw
   * from the call itself still escapes the arrow — which is the whole assertion.
   */
  const settled = (promise: PromiseLike<unknown>): void => void Promise.resolve(promise).catch(() => {})

  it('rejects rather than throwing out of resumeSession', () => {
    // Deliberately not `await`ed inside the assertion: calling it bare is exactly the shape a
    // caller uses, and it is the shape a synchronous throw escapes.
    expect(() => settled(refusing().resumeSession!({ sessionId: 'run-42' }))).not.toThrow()
  })

  it('carries the backend refusal as the rejection value', async () => {
    await expect(refusing().resumeSession!({ sessionId: 'run-42' }))
      .rejects
      .toThrow('no sandbox named run-42')
  })

  it('does the same from createSession, which is where the shape comes from', async () => {
    expect(() => settled(refusing().createSession({ sessionId: 'run-42' }))).not.toThrow()
    await expect(refusing().createSession({ sessionId: 'run-42' }))
      .rejects
      .toThrow('no sandbox named run-42')
  })
})
