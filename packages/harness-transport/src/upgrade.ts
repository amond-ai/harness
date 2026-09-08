/**
 * Turning an upgrade response into the socket the adapter drives.
 *
 * Shared because there are now two ways to reach a bridge — `Sandbox.wsConnect` for a
 * Cloudflare sandbox, `fetch` for a backend that answers with a routable URL — and both end
 * the same way: check the status, take the socket off the response, accept it, wrap it. The
 * checks are the part worth keeping in one place; each of them turns a silent hang into an
 * error that names its cause, and a second copy is a second chance to drop one.
 */
import type { PlatformSocket, WsLike } from './ws-shim'
import { toWsLike } from './ws-shim'

/** What a successful WebSocket upgrade answers with. */
const SWITCHING_PROTOCOLS = 101

/**
 * The socket an upgrade response carries: the half {@link toWsLike} consumes, plus `accept()`.
 *
 * `accept()` is not on the WHATWG `WebSocket` — it is how a runtime that hands the socket back
 * on a *response* says "I will read frames from this now" (workerd's client-side upgrade). A
 * runtime whose upgrade produces an already-open socket never reaches this function at all; it
 * calls {@link toWsLike} directly, as `standard-connect.ts` does.
 */
export interface UpgradeSocket extends PlatformSocket {
  accept: () => void
}

/**
 * The upgrade response, described structurally rather than as a `Response`.
 *
 * `webSocket` is a runtime extension to the Fetch `Response` — workerd sets it, the WHATWG one
 * has no such member — so typing this parameter as `Response` would make the package's own
 * typecheck depend on `@cloudflare/workers-types`. Read off the two members this function uses
 * instead, both optional, so a plain `Response` (the refusal cases, which is what the tests
 * construct) satisfies it and a workerd one does too.
 */
export interface UpgradeResponse {
  readonly status: number
  readonly statusText: string
  readonly body?: { cancel: () => Promise<unknown> } | null
  readonly webSocket?: UpgradeSocket | null
}

/** The two headers this module sets, lower-cased for comparison against an endpoint's own. */
const UPGRADE_HEADERS = new Set(['upgrade', 'connection'])

/**
 * The request headers that ask for the upgrade, on top of whatever the endpoint carries.
 *
 * The endpoint's own are filtered case-insensitively first, and that is the substance rather
 * than tidiness. `BridgeEndpoint.headers` is whatever a backend's `portEndpoint` returned — a
 * preview-auth token, a proxy's routing headers — so its casing is not this package's to
 * assume, while HTTP header names are case-insensitive and `upgrade` names the same header as
 * `Upgrade`. A spread keeps both, because JS object keys are case-*sensitive*, and `fetch`
 * then folds the record through `Headers`, which **combines** duplicates instead of letting
 * the later one win: measured under Bun 1.3.14,
 * `new Headers({ upgrade: 'websocket', Upgrade: 'websocket' })` yields
 * `upgrade: websocket, websocket` and `{ connection: 'keep-alive', Connection: 'Upgrade' }`
 * yields `connection: keep-alive, Upgrade`. Neither is a valid upgrade request, so the dial
 * would fail against a bridge that is answering correctly — and fail with a status, not a
 * cause. Both names are removed, the exactly-cased ones included, so what this function sets
 * is what goes out regardless of key order.
 */
export function upgradeHeaders(headers?: Readonly<Record<string, string>>): Record<string, string> {
  const carried = Object.entries(headers ?? {})
    .filter(([name]) => !UPGRADE_HEADERS.has(name.toLowerCase()))
  return {
    ...Object.fromEntries(carried),
    Upgrade: 'websocket',
    Connection: 'Upgrade',
  }
}

/**
 * Refuse the response, releasing what came with it.
 *
 * A `ReadableStream` holds its underlying source — here, the inbound connection — until it is
 * read to completion or cancelled; letting the last reference go does not release it. Both
 * refusals below run on a misconfigured bridge, which is to say repeatedly, so neither may
 * leave one behind. Not measured, and not claimed to be: it costs one call.
 *
 * The cancel is best-effort and swallowed, the same way the kills in
 * `packages/harness-sandbox/src/process.ts` are: the upgrade error is the cause worth having,
 * and a `cancel()` that rejected with nothing catching it would surface separately as an
 * unhandled rejection in the Worker — a second failure, reported after the first and naming
 * the wrong call.
 */
function refuse(response: UpgradeResponse, message: string): never {
  void response.body?.cancel().catch(() => {})
  throw new Error(message)
}

export function acceptUpgrade(response: UpgradeResponse): WsLike {
  if (response.status !== SWITCHING_PROTOCOLS) {
    refuse(
      response,
      `bridge websocket upgrade refused with ${String(response.status)} ${response.statusText}`,
    )
  }
  const socket = response.webSocket
  if (!socket) {
    refuse(response, 'bridge websocket upgrade returned no websocket')
  }
  // Without `accept()` the Worker never reads a frame: the socket stays parked and every
  // listener the shim registers is silently dead.
  socket.accept()
  return toWsLike(socket)
}
