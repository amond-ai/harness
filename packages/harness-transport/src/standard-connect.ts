/**
 * Opening the bridge socket with the `WebSocket` the runtime already has.
 *
 * This is the opener for everywhere that is not workerd: Deno, Node ≥ 22, Bun and browsers all
 * ship a WHATWG `WebSocket` that dials a `ws://`/`wss://` URL and reports `open` before anything
 * is written. There is nothing to upgrade by hand here — the constructor performs the handshake —
 * so this never touches `upgrade.ts`'s {@link acceptUpgrade}; it waits for the socket to open and
 * hands it to {@link toWsLike}, which is the same shim every other opener ends at.
 *
 * **A turn host needs no headers, and that is why this opener is enough for it.** The bridge's
 * credential rides the URL as the `agent_bridge_token` search param, so a dial that carries only
 * the URL still authenticates. What it cannot carry is a backend's own per-endpoint credential —
 * e2b preview auth, a proxy's routing headers — because the constructor takes no request headers.
 * Dropping them silently is the failure `direct-connect.ts` exists to avoid: the bridge answers a
 * plain authentication refusal and nothing points at the cause. So a non-empty `headers` is
 * refused here by name, and the caller is told which opener can carry them.
 */
import type { BridgeEndpoint } from './endpoint'
import type { PlatformSocket, WsLike } from './ws-shim'
import { toWsLike } from './ws-shim'

/**
 * The `WebSocket` constructor this opener dials with — the runtime's global unless one is passed.
 *
 * Structural rather than `typeof WebSocket`, so a test (or a runtime whose global is behind a
 * flag) can supply one without the two type declarations having to match member for member.
 */
export type WebSocketConstructor = new (url: string) => PlatformSocket

export interface StandardConnectOptions {
  /** Defaults to the runtime's own `WebSocket`, read at dial time rather than at module load. */
  WebSocket?: WebSocketConstructor
}

/**
 * Dial one bridge endpoint, answering once the socket is open.
 *
 * The wait is deliberate and is what makes this interchangeable with the upgrade-based openers:
 * those answer a socket that is already connected, so a caller that got an unopened one back
 * would send its first frame into a socket that has not finished its handshake. A `close` or an
 * `error` before `open` rejects, so a refused dial is a rejected promise rather than a socket
 * that never answers.
 */
export function createStandardSocketOpener(
  options: StandardConnectOptions = {},
): (endpoint: BridgeEndpoint) => Promise<WsLike> {
  return async (endpoint) => {
    refuseHeaders(endpoint)
    const Constructor = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket
    if (Constructor === undefined) {
      throw new Error(
        'this runtime has no global WebSocket: pass one to createStandardSocketOpener, '
        + 'or use a transport built for the runtime',
      )
    }
    const socket = new Constructor(endpoint.url)
    return await opened(socket, endpoint.url)
  }
}

/**
 * Refuse an endpoint whose credential this opener cannot present, naming the headers.
 *
 * By name rather than by count: the point of the error is that the operator can see *which*
 * credential would have been dropped, and therefore whether the endpoint or the opener is the
 * thing to change.
 */
function refuseHeaders(endpoint: BridgeEndpoint): void {
  const names = Object.keys(endpoint.headers ?? {})
  if (names.length > 0) {
    throw new Error(
      `bridge endpoint carries request headers the standard WebSocket constructor cannot send `
      + `(${names.join(', ')}): use a header-capable opener — the workerd fetch upgrade in `
      + `@amond-ai/harness-transport-cloudflare, or Node's ws package`,
    )
  }
}

/** Resolve on `open`; reject on whichever of `error`/`close` arrives first instead. */
async function opened(socket: PlatformSocket, url: string): Promise<WsLike> {
  return await new Promise<WsLike>((resolve, reject) => {
    const onOpen = (): void => settle(() => resolve(toWsLike(socket)))
    const onFailure = (event: unknown): void => settle(() => {
      // The socket is not open, so nothing is holding it — but a runtime that already opened it
      // between the event and this line would leak one, and `close()` on a dead socket is a no-op.
      socket.close()
      reject(dialFailure(url, event))
    })
    const onClose = (): void => settle(() => reject(dialFailure(url, undefined)))
    socket.addEventListener('open', onOpen)
    socket.addEventListener('error', onFailure)
    socket.addEventListener('close', onClose)

    // Declared last but hoisted: each handler settles the dial, and settling detaches all three,
    // so one of the two has to name the other before it exists.
    function settle(finish: () => void): void {
      socket.removeEventListener('open', onOpen)
      socket.removeEventListener('error', onFailure)
      socket.removeEventListener('close', onClose)
      finish()
    }
  })
}

/**
 * The rejection, carrying whatever the runtime said.
 *
 * Runtimes disagree about what an `error` event holds — a bare `Event` in browsers and workerd,
 * an `ErrorEvent` with `.error`/`.message` in Node and Bun — so the cause is read defensively and
 * the URL is always named, since that is the one fact every runtime leaves out.
 */
function dialFailure(url: string, event: unknown): Error {
  const detail = event as { error?: unknown, message?: unknown } | undefined
  const cause = detail?.error ?? detail?.message
  return new Error(
    cause === undefined
      ? `bridge websocket to ${url} closed before it opened`
      : `bridge websocket to ${url} failed to open: ${String(cause)}`,
  )
}
