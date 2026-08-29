import { describe, expect, it } from 'vitest'

/**
 * Read as source, because `ws.ts` cannot be imported outside a Worker build — it resolves
 * `cloudflare:workers`, which is the whole reason the module holds nothing but wiring.
 *
 * The wiring still carries one decision that a reader cannot check locally: `getSandbox` is
 * called here *and* in `cloudflareSandboxProvider.session`, and the two must agree on their
 * options or they resolve different Durable Objects. `normalizeId` changes how the id becomes
 * a DO id, so a bridge socket opened without it would be opened against a different container
 * than the session the run is using — and nothing would report a mismatch, only a bridge that
 * never answers. One exported constant is what makes them agree; this asserts it is the one
 * reached for.
 */
const source = await Bun.file(new URL('./ws.ts', import.meta.url)).text()

describe('ws.ts', () => {
  it('resolves the sandbox under the options every other call site uses', () => {
    const call = /getSandbox\(.*$/m.exec(source)?.[0]

    expect(call).toContain('SANDBOX_OPTIONS')
  })
})
