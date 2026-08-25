import type { WsConnectSandbox } from './cf-connect'
import { describe, expect, it } from 'bun:test'
import { createBridgeSocketOpener } from './cf-connect'

function fakeSandbox(reply: (request: Request, port: number) => Response) {
  const calls: { request: Request, port: number }[] = []
  const sandbox: WsConnectSandbox = {
    wsConnect: (request, port) => {
      calls.push({ request, port })
      return Promise.resolve(reply(request, port))
    },
  }
  return { sandbox, calls }
}

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

const BRIDGE = 'ws://sandbox.invalid:3001/bridge?agent_bridge_token=t0ken'

describe('createBridgeSocketOpener', () => {
  it('dials the port from the endpoint URL', async () => {
    const socket = upgraded()
    const { sandbox, calls } = fakeSandbox(() => socket.response)
    await createBridgeSocketOpener(sandbox)({ url: BRIDGE })
    expect(calls[0]?.port).toBe(3001)
  })

  it('preserves the bridge token, which travels in the query string', async () => {
    const socket = upgraded()
    const { sandbox, calls } = fakeSandbox(() => socket.response)
    await createBridgeSocketOpener(sandbox)({ url: BRIDGE })
    const url = new URL(calls[0]!.request.url)
    expect(url.searchParams.get('agent_bridge_token')).toBe('t0ken')
    expect(url.pathname).toBe('/bridge')
  })

  it('asks for the upgrade and carries the endpoint headers', async () => {
    const socket = upgraded()
    const { sandbox, calls } = fakeSandbox(() => socket.response)
    await createBridgeSocketOpener(sandbox)({
      url: BRIDGE,
      headers: { authorization: 'Bearer s3cret' },
    })
    const { headers } = calls[0]!.request
    expect(headers.get('upgrade')).toBe('websocket')
    expect(headers.get('connection')).toBe('Upgrade')
    expect(headers.get('authorization')).toBe('Bearer s3cret')
  })

  it('accepts the socket, without which no frame is ever delivered', async () => {
    const socket = upgraded()
    const { sandbox } = fakeSandbox(() => socket.response)
    await createBridgeSocketOpener(sandbox)({ url: BRIDGE })
    expect(socket.accepted()).toBe(1)
  })

  it('returns the ws-shaped socket the adapter drives', async () => {
    const socket = upgraded()
    const { sandbox } = fakeSandbox(() => socket.response)
    const ws = await createBridgeSocketOpener(sandbox)({ url: BRIDGE })
    expect(typeof ws.on).toBe('function')
    expect(typeof ws.terminate).toBe('function')
  })

  it('reports the status when the upgrade is refused', async () => {
    const { sandbox } = fakeSandbox(() => new Response('nope', { status: 502 }))
    await expect(createBridgeSocketOpener(sandbox)({ url: BRIDGE })).rejects.toThrow(/502/)
  })

  it('refuses a 101 that carries no socket rather than returning a broken shim', async () => {
    const { sandbox } = fakeSandbox(() => ({ status: 101, webSocket: null } as unknown as Response))
    await expect(createBridgeSocketOpener(sandbox)({ url: BRIDGE })).rejects.toThrow(/no websocket/i)
  })

  /**
   * A producer cannot keep `:80` in a `ws:` URL — WHATWG canonicalisation strips a port that
   * equals the scheme's default, measured on 2026-08-25:
   * `new URL('ws://localhost:80/').toString()` is `ws://localhost/`, and reparsing it yields
   * `port === ''`. So a caller that asked `getPortEndpoint({ port: 80 })` and one that named
   * no port at all produce the same string, and the reader has to pick a reading. The
   * standard one is that an omitted port on a special scheme *is* the default port.
   */
  it.each([
    ['ws://sandbox.invalid/bridge', 80],
    ['wss://sandbox.invalid/bridge', 443],
    ['http://sandbox.invalid/bridge', 80],
    ['https://sandbox.invalid/bridge', 443],
  ])('dials the scheme default for %s, which canonicalisation erased', async (url, port) => {
    const socket = upgraded()
    const { sandbox, calls } = fakeSandbox(() => socket.response)
    await createBridgeSocketOpener(sandbox)({ url })
    expect(calls[0]?.port).toBe(port)
  })

  it('refuses a scheme with no default port, which leaves nothing to dial', async () => {
    const socket = upgraded()
    const { sandbox, calls } = fakeSandbox(() => socket.response)
    await expect(
      createBridgeSocketOpener(sandbox)({ url: 'foo://sandbox.invalid/bridge' }),
    ).rejects.toThrow(/port/i)
    // Refused *before* anything was dialed. An opener that guessed a port, opened the socket
    // and only then complained rejects with the same message while having reached into the
    // container — and left whatever it opened behind.
    expect(calls).toEqual([])
  })
})
