/**
 * One connection to a turn host, as the round drives it.
 *
 * A thin queue over `WsLike`: frames in, JSON commands out, and a `next()` that a caller can
 * put a deadline on. It takes the socket already opened rather than opening one, so everything
 * here runs in `bun test` against a scripted socket and the two things that cannot — `wsConnect`
 * and `fetch` — stay in `sdk-socket.ts`.
 *
 * Frames are queued from the moment the channel is built, never dropped while nothing is
 * reading: the round consumes them one at a time and a burst replayed by `resume` arrives
 * faster than it is read. `ws-shim` holds its own queue until a `message` listener exists, so
 * the listener registered here is the only one that has to be in place before the socket
 * announces itself — which is why the channel is built immediately after the opener resolves.
 */
import type { WsLike } from '@amond-ai/harness-transport'

/** Why `next()` came back with nothing. */
export type ChannelEnd = 'closed' | 'deadline'

export interface TurnChannel {
  /** Send one command; a JSON object, exactly as `inboundMessageSchema` describes it. */
  send: (message: Record<string, unknown>) => void
  /** The next frame's text, or why there is none. Never rejects. */
  next: (timeoutMs: number) => Promise<{ frame: string } | { end: ChannelEnd }>
  /** Whether the socket has reported a close. */
  readonly closed: boolean
  /** Close without waiting for anything; safe to call twice. */
  close: () => void
}

export function createTurnChannel(socket: WsLike): TurnChannel {
  const queued: string[] = []
  let waiter: ((value: { frame: string } | { end: ChannelEnd }) => void) | undefined
  let closed = false

  const deliver = (value: { frame: string } | { end: ChannelEnd }): void => {
    const resolve = waiter
    waiter = undefined
    resolve?.(value)
  }

  socket.on('message', (raw) => {
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw)
    if (waiter) {
      deliver({ frame: text })
      return
    }
    queued.push(text)
  })
  socket.on('close', () => {
    closed = true
    deliver({ end: 'closed' })
  })
  // A socket that errors is a socket the round must stop waiting on. `ws-shim` reports the
  // cause here and nowhere else, so an unregistered handler would turn a failed connection into
  // a wait that only the deadline ends.
  socket.on('error', () => {
    closed = true
    deliver({ end: 'closed' })
  })

  return {
    send: message => socket.send(JSON.stringify(message)),
    next: async (timeoutMs) => {
      const buffered = queued.shift()
      if (buffered !== undefined) {
        return { frame: buffered }
      }
      if (closed) {
        return { end: 'closed' }
      }
      return await new Promise<{ frame: string } | { end: ChannelEnd }>((resolve) => {
        let settle: (value: { frame: string } | { end: ChannelEnd }) => void
        // Cancelled in the same turn it fires, so a round that ends on a frame leaves no
        // dangling timer behind — the failure PR-72 removed from the cli watchdog.
        const timer = setTimeout(() => {
          // Only this call's own waiter: a deadline that fired after a frame already settled
          // must not retire whatever the next `next()` is waiting on.
          if (waiter === settle) {
            waiter = undefined
            resolve({ end: 'deadline' })
          }
        }, timeoutMs)
        settle = (value) => {
          clearTimeout(timer)
          resolve(value)
        }
        waiter = settle
      })
    },
    get closed() {
      return closed
    },
    close: () => {
      closed = true
      socket.close()
      // A caller that closes while a `next()` is pending gets its answer now rather than at the
      // socket's close event — which a socket that is already gone may never fire — or at that
      // read's deadline. `deliver` clears the waiter before resolving, so the close event that
      // does arrive later finds nothing to settle twice.
      deliver({ end: 'closed' })
    },
  }
}
