/**
 * Opening the harness bridge socket the Cloudflare way.
 *
 * `@ai-sdk/harness-claude-code` dials the bridge with `new WebSocket(endpoint.url)` from the
 * `ws` package. That cannot work in a Worker (see `ws-shim.ts`), and it is also the wrong
 * shape here: a Worker does not dial a sandbox by URL, it asks the sandbox's Durable Object to
 * open the socket for it. `@cloudflare/sandbox` 1.0 has no API for that, so the upgrade goes to
 * the Durable Object's own `fetch()`, with the port named in {@link SANDBOX_PORT_HEADER}.
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

/** The header that names the container port a request to the sandbox's Durable Object is for. */
export const SANDBOX_PORT_HEADER = 'X-Sandbox-Port'

/** What this module needs of the sandbox's Durable Object stub, structural so tests can stand in. */
export interface SandboxFetcher {
  fetch: (request: Request) => Promise<Response>
}

/**
 * What a special scheme means by an omitted port.
 *
 * The Durable Object needs the port as a number and the endpoint URL is the only place to get one,
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
  sandbox: SandboxFetcher,
): (endpoint: BridgeEndpoint) => Promise<WsLike> {
  return async (endpoint) => {
    const target = new URL(endpoint.url)
    const port = target.port === '' ? DEFAULT_PORTS[target.protocol] : Number(target.port)
    if (port === undefined) {
      throw new Error(`bridge endpoint '${endpoint.url}' names no port to connect to`)
    }

    // Rebuilt against `localhost` because the request is routed inside the container by the
    // Durable Object, not resolved over DNS — but path and search are carried across verbatim,
    // since the search holds the bridge token.
    // `set`, not a spread: an endpoint header of the same name in another case would otherwise
    // be appended beside ours and reach the Durable Object as `<theirs>, <port>`.
    const headers = new Headers(upgradeHeaders(endpoint.headers))
    headers.set(SANDBOX_PORT_HEADER, String(port))
    const request = new Request(`http://localhost:${String(port)}${target.pathname}${target.search}`, { headers })

    return acceptUpgrade(await sandbox.fetch(request))
  }
}
