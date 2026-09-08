import type { Server } from 'bun'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createStandardSocketOpener } from './standard-connect'

/**
 * Against a real socket, not a stub.
 *
 * The whole claim of this opener is that the runtime's own `WebSocket` is enough to reach a
 * bridge, and a fake constructor cannot say anything about that — it would assert the shim's
 * event plumbing over again and leave the handshake, the frame encoding and the close code
 * untested. The suite runs under `bun --bun`, so `Bun.serve` gives a real WebSocket peer in the
 * same process; anything that only appears against a real server (a close code arriving as a
 * number, a text frame arriving as a string) is therefore in scope here.
 */
let server: Server<undefined>

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: (request, self) => (self.upgrade(request) ? undefined : new Response('expected an upgrade', { status: 426 })),
    websocket: {
      message: (socket, message) => {
        socket.send(`echo:${String(message)}`)
      },
    },
  })
})

afterAll(async () => {
  await server.stop(true)
})

function endpointUrl(): string {
  return `ws://127.0.0.1:${String(server.port)}/bridge?agent_bridge_token=tok`
}

describe('createStandardSocketOpener', () => {
  it('opens, round-trips a frame and reports the peer\'s close code', async () => {
    const socket = await createStandardSocketOpener()({ url: endpointUrl() })

    const echoed = await new Promise<string | ArrayBuffer>((resolve) => {
      socket.on('message', resolve)
      socket.send('ping')
    })
    expect(echoed).toBe('echo:ping')

    const closed = await new Promise<[number, string]>((resolve) => {
      socket.on('close', (code, reason) => resolve([code, reason]))
      socket.close(1000, 'done')
    })
    expect(closed[0]).toBe(1000)
  })

  /**
   * The socket is answered *open*, which is what makes this interchangeable with the
   * upgrade-based openers: they hand back a connected socket, so a caller that received an
   * unopened one would send its first frame into an unfinished handshake. Asserted by sending
   * immediately on the resolved socket above — and here by the negative, that a dial nobody is
   * listening on rejects rather than resolving a socket that never answers.
   */
  it('rejects a dial the peer refuses rather than answering a dead socket', async () => {
    // Port 1 is privileged and unbound in a test environment, so the connect fails outright.
    await expect(createStandardSocketOpener()({ url: 'ws://127.0.0.1:1/bridge' }))
      .rejects
      .toThrow(/ws:\/\/127\.0\.0\.1:1\/bridge/)
  })

  /**
   * Dropping a credential the constructor cannot send is the failure this refusal exists to
   * prevent: the bridge would answer a plain authentication refusal with nothing naming the
   * cause. The error names the headers so an operator can see which one would have been lost.
   */
  it('refuses an endpoint whose headers it cannot present, naming them', async () => {
    await expect(createStandardSocketOpener()({
      url: endpointUrl(),
      headers: { 'X-Preview-Token': 'abc', 'Authorization': 'Bearer t' },
    })).rejects.toThrow(/X-Preview-Token, Authorization/)
  })

  it('says so when the runtime has no WebSocket to dial with', async () => {
    const opener = createStandardSocketOpener({ WebSocket: undefined })
    const global = globalThis as { WebSocket?: unknown }
    const held = global.WebSocket
    delete global.WebSocket
    try {
      await expect(opener({ url: endpointUrl() })).rejects.toThrow(/no global WebSocket/)
    }
    finally {
      global.WebSocket = held
    }
  })
})
