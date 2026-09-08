# `@amond-ai/harness-transport`

The bridge socket a turn driver speaks over, on any runtime that has a `WebSocket`.

The driver in `@amond-ai/harness-claude-code` attaches to a turn host over one socket. It does not
care who dialed it, only that what comes back wears the `ws` API it drives — so this package owns
that shape (`WsLike`), the shim that puts it on a platform `WebSocket`, the upgrade handshake, and
one opener built on the standard constructor.

## What it provides

| Export | Purpose |
| --- | --- |
| `BridgeEndpoint` | Where the turn host is: a `url`, and optionally `headers`. |
| `createStandardSocketOpener(options?)` | `BridgeEndpoint` → an open, `ws`-shaped socket, dialed with `globalThis.WebSocket` (or an injected constructor). |
| `toWsLike(socket)` | A platform `WebSocket` wearing the `ws` API the driver drives. |
| `acceptUpgrade(response)` | The 101 side of the handshake, for an opener that dials over `fetch`. |
| `upgradeHeaders(endpoint)` | The `Upgrade: websocket` request headers. |

## Headers are the fork in the road

The standard `WebSocket` constructor takes a URL and nothing else: there is no way to send a
request header with the handshake. `createStandardSocketOpener` therefore **rejects** an endpoint
that carries `headers`, naming the keys it would have had to drop, rather than dialing an
unauthenticated socket that fails later and elsewhere. An endpoint with headers needs a
header-capable opener — the workerd `fetch` upgrade in `@amond-ai/harness-transport-cloudflare`, or
Node's `ws` package.

That is also why the Cloudflare opener is a separate package rather than a branch in this one: a
Cloudflare Sandbox port is private, reachable only through `Sandbox.wsConnect(request, port)`, so
it dials a `Request` and needs `@cloudflare/sandbox`. Nothing in *this* package's `src` imports
`cloudflare:`, `node:` or `bun:`, and `closure.test.ts` in `@amond-ai/harness-claude-code` keeps it
that way.
