import type { WsLike } from './ws-shim'
import { describe, expect, it } from 'vitest'
import { createWebSocketClass, SANDBOX_ID_PARAM } from './ws-compat'

function stubSocket() {
  const handlers = new Map<string, ((...args: any[]) => void)[]>()
  const sent: string[] = []
  const closed: { code?: number, reason?: string }[] = []
  let terminated = 0
  const ws: WsLike = {
    on: ((event: string, handler: (...args: any[]) => void) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    }) as WsLike['on'],
    off: (event, handler) => {
      handlers.set(event, (handlers.get(event) ?? []).filter(h => h !== handler))
    },
    send: data => sent.push(data),
    // Both arguments recorded: `SandboxChannel` reads the reason off the close event, so a
    // shim that forwarded the code alone would satisfy a code-only assertion while losing the
    // only thing that says *why* the socket went away.
    close: (code, reason) => closed.push({ code, reason }),
    terminate: () => { terminated++ },
  }
  return {
    ws,
    sent,
    closed,
    terminated: () => terminated,
    fire: (event: string, ...args: unknown[]) => {
      for (const handler of handlers.get(event) ?? []) {
        handler(...args)
      }
    },
  }
}

function URL_FOR(id: string, port = 3001): string {
  return `ws://sandbox.invalid:${String(port)}/bridge?agent_bridge_token=t0ken&${SANDBOX_ID_PARAM}=${id}`
}

function harness(open: (endpoint: { url: string }) => Promise<WsLike>) {
  const asked: string[] = []
  const dialed: string[] = []
  const WebSocket = createWebSocketClass({
    openSocket: (sandboxId, endpoint) => {
      asked.push(sandboxId)
      return open(endpoint)
    },
    dialDirect: (endpoint) => {
      dialed.push(endpoint.url)
      return open(endpoint)
    },
  })
  return { WebSocket, asked, dialed }
}

const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0))

describe('createWebSocketClass', () => {
  it('routes to the sandbox named in the URL', async () => {
    const stub = stubSocket()
    const { WebSocket, asked } = harness(() => Promise.resolve(stub.ws))
    void new WebSocket(URL_FOR('run-42'))
    await settle()
    expect(asked).toEqual(['run-42'])
  })

  it('strips its own routing parameter, which the bridge never asked for', async () => {
    const stub = stubSocket()
    let seen = ''
    const { WebSocket } = harness((endpoint) => {
      seen = endpoint.url
      return Promise.resolve(stub.ws)
    })
    void new WebSocket(URL_FOR('run-42'))
    await settle()
    expect(seen).not.toContain(SANDBOX_ID_PARAM)
    expect(seen).toContain('agent_bridge_token=t0ken')
    expect(new URL(seen).port).toBe('3001')
  })

  /**
   * An untagged URL is not a mistake: a backend whose ports are publicly routable — e2b
   * answers `wss://<port>-<id>.e2b.app` — mints exactly that, and the only correct thing to
   * do with it is dial it. Only the tagged form goes through a sandbox binding.
   */
  it('dials a URL that names no sandbox directly, binding untouched', async () => {
    const stub = stubSocket()
    const { WebSocket, asked, dialed } = harness(() => Promise.resolve(stub.ws))
    const socket = new WebSocket('wss://3001-sbx.e2b.app/bridge?agent_bridge_token=t0ken')
    socket.send('early')
    await settle()
    expect(asked).toEqual([])
    expect(dialed).toEqual(['wss://3001-sbx.e2b.app/bridge?agent_bridge_token=t0ken'])
    expect(stub.sent).toEqual(['early'])
  })

  it('carries the endpoint headers into a direct dial, which is what authenticates it', async () => {
    const stub = stubSocket()
    let seen: Record<string, string> | undefined
    const WebSocket = createWebSocketClass({
      openSocket: () => Promise.reject(new Error('should not route through a sandbox')),
      dialDirect: (endpoint) => {
        seen = endpoint.headers as Record<string, string> | undefined
        return Promise.resolve(stub.ws)
      },
    })
    void new WebSocket('wss://3001-sbx.e2b.app/bridge', {
      headers: { authorization: 'Bearer s3cret' },
    })
    await settle()
    expect(seen).toEqual({ authorization: 'Bearer s3cret' })
  })

  it('routes a tagged URL through the sandbox rather than dialing it', async () => {
    const stub = stubSocket()
    const { WebSocket, asked, dialed } = harness(() => Promise.resolve(stub.ws))
    void new WebSocket(URL_FOR('run-42'))
    await settle()
    expect(asked).toEqual(['run-42'])
    expect(dialed).toEqual([])
  })

  it('delivers messages that arrive before the caller attaches a handler', async () => {
    const stub = stubSocket()
    const { WebSocket } = harness(() => Promise.resolve(stub.ws))
    const socket = new WebSocket(URL_FOR('run-42'))
    const seen: unknown[] = []
    socket.on('message', raw => seen.push(raw))
    await settle()
    stub.fire('message', 'hello')
    expect(seen).toEqual(['hello'])
  })

  it('queues a send issued before the socket is open, then flushes it', async () => {
    const stub = stubSocket()
    const { WebSocket } = harness(() => Promise.resolve(stub.ws))
    const socket = new WebSocket(URL_FOR('run-42'))
    socket.send('early')
    expect(stub.sent).toEqual([])
    await settle()
    expect(stub.sent).toEqual(['early'])
  })

  it('reports a failed connect as an `error`, the way a real client does', async () => {
    const { WebSocket } = harness(() => Promise.reject(new Error('container down')))
    const socket = new WebSocket(URL_FOR('run-42'))
    const errors: unknown[] = []
    socket.on('error', err => errors.push(err))
    await settle()
    expect(String(errors[0])).toContain('container down')
  })

  /**
   * A handler that was taken back is a handler that is no longer interested. The failure is
   * replayed asynchronously — the connect can fail before anyone has registered — so there is
   * a window in which the caller can `off()` between the schedule and the delivery, and the
   * adapter's connect-failure cleanup does exactly that. Delivering anyway calls a handler the
   * caller has already retired, on a socket it has stopped watching.
   */
  it('does not replay a failed connect to a handler removed before delivery', async () => {
    const { WebSocket } = harness(() => Promise.reject(new Error('container down')))
    const socket = new WebSocket(URL_FOR('run-42'))
    await settle()
    const errors: unknown[] = []
    const handler = (err: unknown): number => errors.push(err)
    socket.on('error', handler)
    socket.off('error', handler)
    await settle()
    expect(errors).toEqual([])
  })

  it('closes a socket the caller gave up on before it finished connecting', async () => {
    const stub = stubSocket()
    const { WebSocket } = harness(() => Promise.resolve(stub.ws))
    const socket = new WebSocket(URL_FOR('run-42'))
    socket.close(1001, 'gone')
    await settle()
    expect(stub.closed).toEqual([{ code: 1001, reason: 'gone' }])
  })

  it('honours terminate issued before the connection lands', async () => {
    const stub = stubSocket()
    const { WebSocket } = harness(() => Promise.resolve(stub.ws))
    const socket = new WebSocket(URL_FOR('run-42'))
    socket.terminate()
    await settle()
    expect(stub.terminated()).toBe(1)
  })
})
