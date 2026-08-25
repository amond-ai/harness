import { describe, expect, it } from 'bun:test'
import { acceptUpgrade, upgradeHeaders } from './upgrade'

/**
 * The headers an endpoint carries are not this package's to trust the casing of.
 *
 * `BridgeEndpoint.headers` is whatever the backend's `portEndpoint` returned — e2b's preview
 * auth, a proxy's own routing headers — and HTTP header names are case-insensitive, so an
 * endpoint spelling `upgrade` in lower case names the same header as the `Upgrade` added here.
 * A plain spread keeps both, because JS object keys are case-*sensitive*, and `Headers`
 * combines what it is then handed rather than letting one win: measured under Bun 1.3.14,
 * `new Headers({ upgrade: 'websocket', Upgrade: 'websocket' })` yields
 * `upgrade: websocket, websocket`, and `{ connection: 'keep-alive', Connection: 'Upgrade' }`
 * yields `connection: keep-alive, Upgrade`. Neither is a valid upgrade request, so the dial
 * fails at a server that is working perfectly.
 */
describe('upgradeHeaders', () => {
  it('adds the upgrade pair when the endpoint carries neither', () => {
    expect(upgradeHeaders({ Authorization: 'Bearer t' })).toEqual({
      Authorization: 'Bearer t',
      Upgrade: 'websocket',
      Connection: 'Upgrade',
    })
  })

  it('replaces an endpoint\'s own upgrade headers whatever case they are spelled in', () => {
    expect(upgradeHeaders({
      'upgrade': 'websocket',
      'CONNECTION': 'keep-alive',
      'x-preview-token': 'abc',
    })).toEqual({
      'x-preview-token': 'abc',
      'Upgrade': 'websocket',
      'Connection': 'Upgrade',
    })
  })

  /**
   * The exact-case spelling has to go through the same removal, not merely be overwritten by
   * the spread: a filter that skipped it would leave the pair's ordering as the only thing
   * keeping the result right, which is not something a reader can check.
   */
  it('carries exactly one entry per upgrade header when the endpoint spells them exactly', () => {
    const headers = upgradeHeaders({ Upgrade: 'h2c', Connection: 'close' })

    expect(Object.keys(headers).filter(name => name.toLowerCase() === 'upgrade')).toEqual(['Upgrade'])
    expect(Object.keys(headers).filter(name => name.toLowerCase() === 'connection')).toEqual(['Connection'])
    expect(headers).toEqual({ Upgrade: 'websocket', Connection: 'Upgrade' })
  })

  it('works with no endpoint headers at all', () => {
    expect(upgradeHeaders()).toEqual({ Upgrade: 'websocket', Connection: 'Upgrade' })
  })

  /**
   * The whole point, stated the way the runtime sees it: through `Headers`, which is what
   * `fetch` builds from the record. A duplicate that survives this far combines rather than
   * overrides, so asserting the record alone would miss half of what went wrong.
   */
  it('produces a single-valued upgrade pair once Headers has folded it', () => {
    const headers = new Headers(upgradeHeaders({ upgrade: 'websocket', connection: 'keep-alive' }))

    expect(headers.get('upgrade')).toBe('websocket')
    expect(headers.get('connection')).toBe('Upgrade')
  })
})

/**
 * A refused upgrade still arrives with a body, and dropping the reference is not releasing it.
 *
 * The Streams spec keeps a `ReadableStream`'s underlying source alive until the stream is read
 * to completion or cancelled; nothing in it releases one because the last reference went away.
 * In a Worker that source is the inbound HTTP connection, so the refusal path — the one that
 * runs when a bridge is misconfigured and therefore runs repeatedly — is exactly where an
 * unreleased body would accumulate. Cancelling costs one call and needs no measurement to
 * justify; what is *not* claimed here is a measured leak.
 */
describe('acceptUpgrade', () => {
  it('releases the body of a response that refused the upgrade', () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        cancelled = true
      },
    })
    const response = new Response(body, { status: 502, statusText: 'Bad Gateway' })

    expect(() => acceptUpgrade(response)).toThrow(/refused with 502/)
    expect(cancelled).toBe(true)
  })

  /**
   * Best-effort cleanup must not displace the cause, and must not become a second failure.
   *
   * `cancel()` answers a promise, and a rejected one nobody handles surfaces in a Worker as an
   * unhandled rejection — reported *after* the refusal it was cleaning up after, naming the
   * wrong call. Same shape as the kills in `packages/harness-sandbox/src/process.ts`, which
   * are `.catch(() => {})`-ed for the same reason, and settled the same way here.
   */
  it('still throws the refusal when releasing the body fails, and leaves nothing unhandled', async () => {
    const unhandled: unknown[] = []
    const record = (cause: unknown): void => void unhandled.push(cause)
    process.on('unhandledRejection', record)
    try {
      const body = new ReadableStream<Uint8Array>({
        cancel: () => {
          throw new Error('cancel failed')
        },
      })
      const response = new Response(body, { status: 502, statusText: 'Bad Gateway' })

      expect(() => acceptUpgrade(response)).toThrow(/refused with 502/)
      // A rejection is reported once the microtask queue drains, not synchronously.
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(unhandled).toEqual([])
    }
    finally {
      process.off('unhandledRejection', record)
    }
  })
})
