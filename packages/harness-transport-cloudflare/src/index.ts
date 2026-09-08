/**
 * The bridge transport for workerd, whichever sandbox backend is behind it.
 *
 * The runtime-neutral half of the transport — {@link WsLike}, `toWsLike`, `upgradeHeaders`,
 * `acceptUpgrade`, and the standard-`WebSocket` opener every other runtime uses — is
 * `@amond-ai/harness-transport`. What is left here is the part workerd needs and nothing else
 * can use, which is why the split exists at all: a Cloudflare sandbox's bridge port is
 * *private*, so it is not dialed by URL. The port endpoint is a tag, and the socket is opened by
 * the Sandbox Durable Object (`cf-connect.ts`). A backend with publicly routable ports — e2b —
 * answers with a real address, dialed through workerd's own `fetch` upgrade so the endpoint's
 * request headers travel with it (`direct-connect.ts`).
 *
 * `@ai-sdk/harness`'s `SandboxChannel` already takes its socket as an injected
 * `connect: () => Promise<WebSocket>` thunk, so the core needs no change to speak over something
 * other than `ws`. `@ai-sdk/harness-claude-code` does not: it asks the session for
 * `getPortEndpoint` and then builds the socket itself with `new WebSocket(url, { headers })` from
 * the `ws` package, which cannot run in a Worker at all (see `harness-transport`'s `ws-shim.ts`).
 * A wrangler `alias` points `ws` at `./ws`, and `ws-compat.ts` is what that stand-in does instead.
 */
export type { WsConnectSandbox } from './cf-connect'
export { createBridgeSocketOpener } from './cf-connect'
export type { DialFetch } from './direct-connect'
export { createDirectSocketOpener } from './direct-connect'
export type { WebSocketClassOptions, WsClient } from './ws-compat'
export { createWebSocketClass, SANDBOX_ID_PARAM, SANDBOX_OPTIONS } from './ws-compat'
