import type { Sandbox } from '@vercel/sandbox'
import type { VercelSandboxLike } from './vercel-surface'
import { describe, expect, it } from 'vitest'
import { surfaceOf } from './vercel-api'

/**
 * The two properties of the real `Sandbox` this module reads *after* construction.
 *
 * Hand-rolled rather than taken from the fake sandbox every other suite uses, and that is the
 * point: the fake models `routes` as a live view, so it agrees with a correct adapter and with a
 * broken one alike. This file is the only place the adapter itself is under test.
 */
interface MutableSandbox {
  readonly sandbox: Sandbox
  setRoutes: (routes: { url: string, subdomain: string, port: number }[]) => void
  setExpiresAt: (expiresAt: Date | undefined) => void
}

function sandboxStub(): MutableSandbox {
  let routes: { url: string, subdomain: string, port: number }[] = []
  let expiresAt: Date | undefined
  const stub = {
    name: 'sbx-1',
    get routes() {
      return routes
    },
    get expiresAt() {
      return expiresAt
    },
  }
  return {
    // Only the members `surfaceOf` reads at construction are here; the cast is what lets a stub
    // this small stand in for a class with forty accessors.
    sandbox: stub as unknown as Sandbox,
    setRoutes: (value) => {
      routes = value
    },
    setExpiresAt: (value) => {
      expiresAt = value
    },
  }
}

/** The adapter as it was written in stage 4 — a snapshot taken at construction. */
function snapshotOf(sandbox: Sandbox): Pick<VercelSandboxLike, 'routes' | 'expiresAt'> {
  return { routes: sandbox.routes.map(route => ({ ...route })), expiresAt: sandbox.expiresAt }
}

describe('surfaceOf', () => {
  it('reads routes through to the sandbox rather than copying them once', () => {
    const stub = sandboxStub()
    const surface = surfaceOf(stub.sandbox)

    // The `ensureRouted` shape: read, mutate the source, read again. A repair calls
    // `update({ ports })` and then re-reads `routes` on this object to confirm the route landed,
    // so an adapter that copied at construction would report that an update it had just made had
    // routed nothing — and `portEndpoint` would be unusable for the `sdk` driver, which cannot
    // know the bridge's port until long after the sandbox was created.
    expect(surface.routes).toEqual([])
    stub.setRoutes([{ url: 'https://sbx-1-3000.vercel.run', subdomain: 'sbx-1-3000', port: 3000 }])

    expect(surface.routes).toEqual([{ url: 'https://sbx-1-3000.vercel.run', subdomain: 'sbx-1-3000', port: 3000 }])
  })

  it('reads expiresAt through to the sandbox, because extendTimeout moves it', () => {
    const stub = sandboxStub()
    const surface = surfaceOf(stub.sandbox)

    expect(surface.expiresAt).toBeUndefined()
    stub.setExpiresAt(new Date('2026-09-14T14:00:00.000Z'))

    // `lifetime.ts` seeds its deadline from this and prefers it over the configured lifetime, so
    // a value frozen at acquisition would be the stale half of the very disagreement that seed
    // exists to settle.
    expect(surface.expiresAt).toEqual(new Date('2026-09-14T14:00:00.000Z'))
  })

  it('is a property no snapshot implementation has', () => {
    const stub = sandboxStub()
    const snapshot = snapshotOf(stub.sandbox)
    stub.setRoutes([{ url: 'https://sbx-1-3000.vercel.run', subdomain: 'sbx-1-3000', port: 3000 }])
    stub.setExpiresAt(new Date('2026-09-14T14:00:00.000Z'))

    // Spelled out so the two tests above read as the assertions they are rather than as
    // tautologies: this is exactly what shipped in stage 4, and exactly what it did.
    expect(snapshot.routes).toEqual([])
    expect(snapshot.expiresAt).toBeUndefined()
  })
})
