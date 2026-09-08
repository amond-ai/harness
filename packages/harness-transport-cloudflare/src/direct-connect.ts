/**
 * Opening the harness bridge socket against a URL that is actually routable.
 *
 * The Cloudflare backend's endpoint is a tag, not an address (see `cf-connect.ts`); every
 * other backend's is an address. e2b, for one, answers with a real public host
 * (`wss://<port>-<id>.e2b.app`), and the only correct thing to do with it is dial it.
 *
 * The dial goes through `fetch` rather than `new WebSocket(url)`, and that is the whole
 * reason this module exists instead of one line in `ws-compat.ts`. `SandboxPortEndpoint`
 * carries `headers` alongside the URL — the harness contract's way of saying "present this
 * credential when you connect" — and the standard `WebSocket` constructor takes no request
 * headers at all. A `WebSocket`-based dial would therefore *drop* them silently and surface
 * as an authentication refusal from the bridge with nothing pointing at the cause. Workerd's
 * `fetch` performs the upgrade and hands the socket back on the response, so the headers
 * travel and the shape stays identical to the `wsConnect` path.
 *
 * Which is why {@link toHttpUrl} exists, and it is not tidiness. Workerd's `fetch` refuses
 * the WebSocket schemes outright, before any network activity — measured 2026-08-25 inside
 * the vitest workers pool and pinned in
 * `apps/cf-orchestrator/test/workerd/fetch-websocket-scheme.test.ts`:
 *
 * ```
 * fetch('ws://127.0.0.1:1/')   → TypeError: Fetch API cannot load: ws://127.0.0.1:1/
 * fetch('wss://127.0.0.1:1/')  → TypeError: Fetch API cannot load: wss://127.0.0.1:1/
 * fetch('http://127.0.0.1:1/') → Error: Network connection lost.   ← actually dialed
 * ```
 *
 * And this is the live path, not a corner: `@ai-sdk/harness-claude-code` asks for the
 * endpoint as `getPortEndpoint({ port, protocol: 'ws' })`, so a backend with routable ports
 * mints `ws://…` and every direct dial would die on a `TypeError` that says nothing about
 * the real cause. The `wsConnect` path never sees this because `cf-connect.ts` rebuilds its
 * request as `http://localhost:<port>…` for its own reasons.
 */
import type { BridgeEndpoint, WsLike } from '@amond-ai/harness-transport'
import { acceptUpgrade, upgradeHeaders } from '@amond-ai/harness-transport'

/**
 * The one thing this module needs of `fetch`, taken as an argument so the opener is
 * exercisable without a network — `ws.ts` supplies the global.
 */
export type DialFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<Response>

/**
 * The same URL, spelled the way `fetch` accepts it: `ws:` → `http:`, `wss:` → `https:`.
 *
 * The inverse of `@ai-sdk/provider-utils`'s `toWebSocketUrl`, which is where the name comes
 * from — not the dependency, since one mapping is not worth one.
 *
 * Only those two are mapped. A URL that already speaks HTTP is returned as it stands, and so
 * is a scheme this does not know: refusing one here would make the transport the owner of a
 * scheme allowlist it has no business owning, and workerd's own `TypeError` already names the
 * URL it would not load. Everything but the scheme survives byte-for-byte — in particular the
 * search string, which carries the bridge's `agent_bridge_token`.
 */
function toHttpUrl(url: string): string {
  const target = new URL(url)
  if (target.protocol === 'ws:') {
    target.protocol = 'http:'
  }
  else if (target.protocol === 'wss:') {
    target.protocol = 'https:'
  }
  else {
    return url
  }
  return target.toString()
}

export function createDirectSocketOpener(
  dial: DialFetch,
): (endpoint: BridgeEndpoint) => Promise<WsLike> {
  return async (endpoint) => {
    const response = await dial(toHttpUrl(endpoint.url), {
      headers: upgradeHeaders(endpoint.headers),
    })
    return acceptUpgrade(response)
  }
}
