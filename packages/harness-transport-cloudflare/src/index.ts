/**
 * The AI SDK harness bridge transport for workerd, whichever sandbox backend is behind it.
 *
 * `@ai-sdk/harness`'s `SandboxChannel` already takes its socket as an injected
 * `connect: () => Promise<WebSocket>` thunk, so the core needs no change to speak over
 * something other than `ws`. `@ai-sdk/harness-claude-code` does not: it asks the session for
 * `getPortEndpoint` and then builds the socket itself with `new WebSocket(url, { headers })`
 * from the `ws` package, which cannot run in a Worker at all (see `ws-shim.ts`). A wrangler
 * `alias` points `ws` at `./ws`, and everything under it is what that stand-in does instead.
 *
 * Two backends reach a bridge two ways, and the endpoint URL says which. A Cloudflare
 * sandbox's bridge port is private, so its `portEndpoint` tags the URL with
 * {@link SANDBOX_ID_PARAM} and the socket is opened by the Durable Object (`cf-connect.ts`).
 * A backend with publicly routable ports — e2b — answers with a real `wss://` URL, and that
 * is dialed as it stands (`direct-connect.ts`). The name says Cloudflare because the runtime
 * is workerd, not because the sandbox has to be.
 */
export type { BridgeEndpoint, WsConnectSandbox } from './cf-connect'
export { createBridgeSocketOpener } from './cf-connect'
export type { DialFetch } from './direct-connect'
export { createDirectSocketOpener } from './direct-connect'
export { acceptUpgrade, upgradeHeaders } from './upgrade'
export type { WebSocketClassOptions, WsClient } from './ws-compat'
export { createWebSocketClass, SANDBOX_ID_PARAM, SANDBOX_OPTIONS } from './ws-compat'
export type { CloseReason, PlatformEvent, PlatformSocket, WsLike } from './ws-shim'
export { toWsLike } from './ws-shim'
