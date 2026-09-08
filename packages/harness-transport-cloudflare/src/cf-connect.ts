/**
 * Opening the harness bridge socket the Cloudflare way.
 *
 * `@ai-sdk/harness-claude-code` dials the bridge with `new WebSocket(endpoint.url)` from the
 * `ws` package. That cannot work in a Worker (see `ws-shim.ts`), and it is also the wrong
 * shape here: a Worker does not dial a sandbox by URL, it asks the Sandbox Durable Object to
 * open the socket for it. `Sandbox.wsConnect(request, port)` is the SDK's own API for exactly
 * that — the same upgrade-request pattern its internal RPC control connection uses — and it
 * keeps the bridge port private, unlike `exposePort`, which publishes it.
 *
 * Measured against a real container on 2026-08-25, not only read: the upgrade answers 101, the
 * accepted socket echoes a frame back and closes with 1000, and the peer confirms it received
 * both details below. See `.please/docs/research/md/028-cloudflare-wsconnect-bridge-socket-spike.md`
 * for the run and for what it still does not cover — the peer there is an echo server, not the
 * AI SDK bridge.
 *
 * Two details are load-bearing and both come from reading the adapter rather than guessing:
 *
 * - **The query string carries the bridge's credential.** `withBridgeToken` appends
 *   `agent_bridge_token` to the endpoint URL as a search param, so a connect that rebuilt the
 *   URL from the port and path alone would authenticate as nobody and be refused by a bridge
 *   that is working correctly.
 * - **`endpoint.headers` are scoped to that URL and must be sent.** The contract says so, and
 *   the adapter passes them to `ws` as request headers.
 */
import type { BridgeEndpoint, WsLike } from '@amond-ai/harness-transport'
import { acceptUpgrade, upgradeHeaders } from '@amond-ai/harness-transport'

/** The one `@cloudflare/sandbox` method this module needs, structural so tests can stand in. */
export interface WsConnectSandbox {
  wsConnect: (request: Request, port: number) => Promise<Response>
}

/**
 * What a special scheme means by an omitted port.
 *
 * `wsConnect` takes the port as a number and the endpoint URL is the only place to get one,
 * but the string cannot always carry it. WHATWG canonicalisation deletes a port equal to the
 * scheme's default: `new URL('ws://localhost:80/').toString()` is `ws://localhost/`, and
 * reparsing that yields `port === ''` — measured on 2026-08-25 under Bun 1.3.14 for all four
 * of `http`/`https`/`ws`/`wss`. No conforming producer can avoid it, so
 * `getPortEndpoint({ port: 80, protocol: 'ws' })` and a producer that named no port at all
 * mint the same string, and nothing downstream can tell them apart.
 *
 * Since they are indistinguishable, this reads the omission the way the URL standard does:
 * on a special scheme an absent port *is* the default port. An earlier note here argued the
 * opposite — that 80/443 is "certainly not where an in-sandbox bridge listens", so dialing it
 * would surface as a confusing refusal from whatever else answers. That is true of the
 * bridge, but it was deciding a case the string cannot identify, and it decided it against
 * the caller who was explicit: asking for port 80 produced an endpoint this opener then
 * refused as undialable. A confusing refusal from the wrong listener is the cheaper failure,
 * and it only reaches a producer that minted a portless endpoint by mistake.
 *
 * A non-special scheme has no default to fall back on — `new URL('foo://h/b').port` is `''`
 * with nothing implied — so that one still names nothing to dial and is refused.
 */
const DEFAULT_PORTS: Readonly<Record<string, number | undefined>> = {
  'http:': 80,
  'https:': 443,
  'ws:': 80,
  'wss:': 443,
}

export function createBridgeSocketOpener(
  sandbox: WsConnectSandbox,
): (endpoint: BridgeEndpoint) => Promise<WsLike> {
  return async (endpoint) => {
    const target = new URL(endpoint.url)
    const port = target.port === '' ? DEFAULT_PORTS[target.protocol] : Number(target.port)
    if (port === undefined) {
      throw new Error(`bridge endpoint '${endpoint.url}' names no port to connect to`)
    }

    // Rebuilt against `localhost` because the request is routed inside the container by
    // `wsConnect`, not resolved over DNS — but path and search are carried across verbatim,
    // since the search holds the bridge token.
    const request = new Request(`http://localhost:${String(port)}${target.pathname}${target.search}`, {
      headers: upgradeHeaders(endpoint.headers),
    })

    return acceptUpgrade(await sandbox.wsConnect(request, port))
  }
}
