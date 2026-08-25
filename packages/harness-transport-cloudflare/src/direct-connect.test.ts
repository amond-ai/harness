import type { DialFetch } from './direct-connect'
import { describe, expect, it } from 'bun:test'
import { createDirectSocketOpener } from './direct-connect'

function upgraded() {
  let accepted = 0
  const socket = {
    accept: () => { accepted++ },
    addEventListener: () => {},
    removeEventListener: () => {},
    send: () => {},
    close: () => {},
  }
  const response = { status: 101, webSocket: socket } as unknown as Response
  return { response, accepted: () => accepted }
}

function fakeFetch(reply: () => Response) {
  const calls: { url: string, init?: { headers?: Record<string, string> } }[] = []
  const dial: DialFetch = (url, init) => {
    calls.push({ url, init })
    return Promise.resolve(reply())
  }
  return { dial, calls }
}

/** What the harness adapter really asks for: it calls `getPortEndpoint({ port, protocol: 'ws' })`. */
const BRIDGE = 'wss://3001-sbx.e2b.app/bridge?agent_bridge_token=t0ken'
/** The same endpoint as `fetch` will accept it. */
const DIALED = 'https://3001-sbx.e2b.app/bridge?agent_bridge_token=t0ken'

async function dialedUrl(url: string): Promise<string> {
  const socket = upgraded()
  const { dial, calls } = fakeFetch(() => socket.response)
  await createDirectSocketOpener(dial)({ url })
  return calls[0]?.url ?? ''
}

describe('createDirectSocketOpener', () => {
  /**
   * Measured in workerd, not assumed: `fetch` refuses `ws:`/`wss:` outright with
   * `TypeError: Fetch API cannot load: ws://…`, before any network activity, while the same
   * URL under `http:` gets far enough to fail on the connection. The evidence is pinned in
   * `apps/cf-orchestrator/test/workerd/fetch-websocket-scheme.test.ts`; without the rewrite
   * every e2b dial dies with a TypeError that names nothing about the real cause.
   */
  it('rewrites wss: to https:, which is the scheme fetch will accept', async () => {
    expect(await dialedUrl(BRIDGE)).toBe(DIALED)
  })

  it('rewrites ws: to http:', async () => {
    expect(await dialedUrl('ws://3001-sbx.e2b.app/bridge')).toBe('http://3001-sbx.e2b.app/bridge')
  })

  it('leaves an endpoint that already speaks http alone', async () => {
    expect(await dialedUrl('http://localhost:3001/bridge')).toBe('http://localhost:3001/bridge')
  })

  it('leaves an endpoint that already speaks https alone', async () => {
    expect(await dialedUrl('https://localhost:3001/bridge')).toBe('https://localhost:3001/bridge')
  })

  /**
   * The rewrite touches the scheme and nothing else. The search string carries the bridge's
   * `agent_bridge_token`, so a normalization that dropped or re-encoded it would authenticate
   * as nobody against a bridge that is working correctly.
   */
  it('carries path, port and search across the rewrite untouched', async () => {
    const dialed = await dialedUrl('ws://sbx.invalid:3001/bridge?agent_bridge_token=t0ken&x=a%2Fb')
    expect(dialed).toBe('http://sbx.invalid:3001/bridge?agent_bridge_token=t0ken&x=a%2Fb')
  })

  /**
   * Nothing else is mapped, and nothing else is refused here either: the transport is not the
   * place to own a scheme allowlist, and workerd's own `TypeError` already names the URL it
   * would not load. So an unknown scheme is dialed as it stands and fails where it fails.
   */
  it('passes a scheme it does not map through untouched, rather than refusing it itself', async () => {
    expect(await dialedUrl('gopher://sbx.invalid/bridge')).toBe('gopher://sbx.invalid/bridge')
  })

  it('asks for the upgrade and carries the endpoint headers', async () => {
    const socket = upgraded()
    const { dial, calls } = fakeFetch(() => socket.response)
    await createDirectSocketOpener(dial)({
      url: BRIDGE,
      headers: { authorization: 'Bearer s3cret' },
    })
    const headers = calls[0]?.init?.headers
    expect(headers?.Upgrade).toBe('websocket')
    expect(headers?.Connection).toBe('Upgrade')
    expect(headers?.authorization).toBe('Bearer s3cret')
  })

  it('accepts the socket, without which no frame is ever delivered', async () => {
    const socket = upgraded()
    const { dial } = fakeFetch(() => socket.response)
    await createDirectSocketOpener(dial)({ url: BRIDGE })
    expect(socket.accepted()).toBe(1)
  })

  it('returns the ws-shaped socket the adapter drives', async () => {
    const socket = upgraded()
    const { dial } = fakeFetch(() => socket.response)
    const ws = await createDirectSocketOpener(dial)({ url: BRIDGE })
    expect(typeof ws.on).toBe('function')
    expect(typeof ws.terminate).toBe('function')
  })

  it('reports the status when the upgrade is refused', async () => {
    const { dial } = fakeFetch(() => new Response('nope', { status: 502 }))
    await expect(createDirectSocketOpener(dial)({ url: BRIDGE })).rejects.toThrow(/502/)
  })

  it('refuses a 101 that carries no socket rather than returning a broken shim', async () => {
    const { dial } = fakeFetch(() => ({ status: 101, webSocket: null } as unknown as Response))
    await expect(createDirectSocketOpener(dial)({ url: BRIDGE })).rejects.toThrow(/no websocket/i)
  })
})
