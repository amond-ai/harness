import type { HarnessV1NetworkSandboxSession } from '@ai-sdk/harness'
import { describe, expect, it } from 'vitest'
import { fakeSandboxProvider } from './sandbox.fixtures'
import { createHarnessSandboxSession } from './session'

function session(sandboxId = 'sbx-1', failingDestroys?: number) {
  const { provider, state } = fakeSandboxProvider({ backend: 'fake', failingDestroys })
  return {
    session: createHarnessSandboxSession({
      sandboxes: provider,
      sandboxId,
      defaultWorkingDirectory: '/workspace',
      ports: [3001, 3002],
    }),
    state,
  }
}

describe('createHarnessSandboxSession', () => {
  /**
   * The strongest check available: upstream's own declaration does the checking rather than
   * this package's reading of it, so a member the harness adds or un-optionalises fails the
   * type check instead of surfacing at the first connect inside a workflow step.
   */
  it('satisfies the harness session type', () => {
    const built = session().session satisfies HarnessV1NetworkSandboxSession

    expect(built.id).toBe('sbx-1')
  })

  it('carries the sandbox id, working directory and ports the caller declared', () => {
    const { session: s } = session('sbx-7')

    expect(s.id).toBe('sbx-7')
    expect(s.defaultWorkingDirectory).toBe('/workspace')
    expect(s.ports).toEqual([3001, 3002])
  })

  it('describes the sandbox it is actually bound to', () => {
    const { session: s } = session('sbx-7')

    expect(s.description).toContain('sbx-7')
    expect(s.description).toContain('/workspace')
  })

  describe('ports', () => {
    it('asks the provider where the port is, not the session', async () => {
      const { session: s, state } = session('sbx-7')
      const endpoint = await s.getPortEndpoint({ port: 3001, protocol: 'ws' })

      expect(state.portEndpoints).toEqual([{ sandboxId: 'sbx-7', port: 3001, protocol: 'ws' }])
      expect(endpoint.url).toBe('ws://sbx-7.example/3001')
      expect(endpoint.headers).toEqual({ 'x-fake': 'sbx-7' })
    })

    it('answers the deprecated url form from the same endpoint', async () => {
      const { session: s } = session('sbx-7')

      expect(await s.getPortUrl({ port: 3002, protocol: 'https' })).toBe('https://sbx-7.example/3002')
    })
  })

  describe('lifecycle', () => {
    /**
     * The harness requires `stop` and `destroy` to be idempotent and to survive being called
     * on an already-stopped sandbox. The contract has one `destroy()` and says nothing about
     * calling it twice, so the latch is here.
     */
    it('destroys the sandbox once however many times it is stopped', async () => {
      const { session: s, state } = session()
      await s.stop()
      await s.stop()

      expect(state.destroys).toBe(1)
    })

    it('destroys the sandbox once however many times it is destroyed', async () => {
      const { session: s, state } = session()
      await s.destroy()
      await s.destroy()

      expect(state.destroys).toBe(1)
    })

    /**
     * Latch the success, not the failure. A rejected promise left in the latch is replayed by
     * every later call without touching the backend again, so one transient RPC error would
     * outlive itself and leave the sandbox unreapable for the session's whole life — the bug
     * `lazySession` already fixed once in `packages/amond-ai/sandbox-e2b/src/provider.ts` ("Memoise the
     * acquisition, not its failure", codex review, PR #260).
     */
    it('retries a teardown that failed instead of replaying its rejection', async () => {
      const { session: s, state } = session('sbx-1', 1)

      await expect(s.stop()).rejects.toThrow('destroy failed')
      await s.stop()

      expect(state.destroys).toBe(2)
    })

    it('shares one teardown between callers that race it', async () => {
      const { session: s, state } = session()
      await Promise.all([s.stop(), s.destroy(), s.stop()])

      expect(state.destroys).toBe(1)
    })

    it('accepts destroy on a sandbox that was already stopped', async () => {
      const { session: s, state } = session()
      await s.stop()
      await s.destroy()

      expect(state.destroys).toBe(1)
    })
  })

  describe('restricted', () => {
    /**
     * The harness hands this view to user-tool `execute()` calls, so "does not advertise the
     * infra surface" is not enough — the returned object must genuinely not carry it, or a
     * tool that reaches past the type stops the sandbox it is running inside.
     */
    it('carries no lifecycle, port or policy member at all', () => {
      const restricted = session().session.restricted() as Record<string, unknown>

      for (const member of ['stop', 'destroy', 'ports', 'getPortEndpoint', 'getPortUrl', 'setNetworkPolicy', 'restricted']) {
        expect(restricted[member]).toBeUndefined()
      }
    })

    /**
     * Which sandbox, not merely which file. The fixture gives every id its own session object,
     * so the write is recorded against the id it actually reached: a restricted view derived
     * from a session that resolved the wrong id would still land content at `/x.txt` and
     * satisfy a content-only assertion.
     */
    it('reaches the same sandbox as the session it came from', async () => {
      const { session: s, state } = session()
      await s.restricted().writeTextFile({ path: '/x.txt', content: 'from the restricted view' })

      expect(state.sessions).toEqual(['sbx-1'])
      expect(state.writes.at(-1)?.sandboxId).toBe('sbx-1')
      expect(new TextDecoder().decode(state.files('sbx-1').get('/x.txt'))).toBe('from the restricted view')
    })

    it('still carries the whole file and process surface', () => {
      const restricted = session().session.restricted()

      expect(typeof restricted.readFile).toBe('function')
      expect(typeof restricted.readBinaryFile).toBe('function')
      expect(typeof restricted.readTextFile).toBe('function')
      expect(typeof restricted.writeFile).toBe('function')
      expect(typeof restricted.writeBinaryFile).toBe('function')
      expect(typeof restricted.writeTextFile).toBe('function')
      expect(typeof restricted.run).toBe('function')
      expect(typeof restricted.spawn).toBe('function')
      expect(typeof restricted.description).toBe('string')
    })
  })
})
