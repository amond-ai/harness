import type { WsLike } from '@amond-ai/harness-transport'
import { describe, expect, it } from 'vitest'
import { createTurnChannel } from './sdk-channel'

/**
 * A socket the test drives: it records what was sent, hands the channel its listeners, and — the
 * part that matters here — **does not fire `close` of its own accord**. A real one may not
 * either: `close()` on a socket whose peer is already gone can leave the event unfired, which is
 * exactly the case a `next()` must not be left waiting on.
 */
function scriptedSocket(): WsLike & { sent: string[], emit: (event: string, data?: unknown) => void } {
  const listeners = new Map<string, ((data?: unknown) => void)[]>()
  const sent: string[] = []
  return {
    sent,
    on(event: string, listener: (data?: unknown) => void) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    emit(event: string, data?: unknown) {
      for (const listener of listeners.get(event) ?? []) {
        listener(data)
      }
    },
    send(message: string) {
      sent.push(message)
    },
    close() {},
  } as unknown as WsLike & { sent: string[], emit: (event: string, data?: unknown) => void }
}

describe('createTurnChannel', () => {
  it('delivers a frame to a pending read', async () => {
    const socket = scriptedSocket()
    const channel = createTurnChannel(socket)
    const read = channel.next(1_000)

    socket.emit('message', '{"type":"raw"}')

    expect(await read).toEqual({ frame: '{"type":"raw"}' })
  })

  /**
   * The round closes its channel in a `finally`, and a read is often still outstanding when it
   * does. Left to the socket's own close event — which may never come — or to the read's
   * deadline, the round would hold its step for a whole liveness sample doing nothing.
   */
  it('releases a pending read as soon as it is closed', async () => {
    const socket = scriptedSocket()
    const channel = createTurnChannel(socket)
    const read = channel.next(60_000)

    channel.close()

    expect(await read).toEqual({ end: 'closed' })
  })

  it('settles a released read once, even when the socket reports its close afterwards', async () => {
    const socket = scriptedSocket()
    const channel = createTurnChannel(socket)
    const read = channel.next(60_000)

    channel.close()
    socket.emit('close')

    expect(await read).toEqual({ end: 'closed' })
    // The late event found no waiter, so the *next* read is answered by the closed flag rather
    // than having been retired by an event that belonged to the read before it.
    expect(await channel.next(60_000)).toEqual({ end: 'closed' })
  })
})
