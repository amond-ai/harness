/**
 * The bridge transport, in the part that has no runtime in it.
 *
 * A turn driver talks to its host over one socket, and the only thing it needs of that socket is
 * {@link WsLike} — the `ws`-shaped surface `@ai-sdk/harness`'s `SandboxChannel` and
 * `@ai-sdk/harness-claude-code` both drive. How the socket is *opened* is the part that differs
 * by runtime, so an opener is injected rather than found here.
 *
 * {@link createStandardSocketOpener} is the one that works wherever a WHATWG `WebSocket` exists —
 * Deno, Node ≥ 22, Bun, browsers — which is every runtime but workerd, whose sandbox ports are
 * private and dialed through a binding instead (`@amond-ai/harness-transport-cloudflare`).
 * {@link upgradeHeaders} and {@link acceptUpgrade} are what an opener that performs the upgrade
 * over a *request* is built from, and they live here because both such openers share them.
 */
export type { BridgeEndpoint } from './endpoint'
export type { StandardConnectOptions, WebSocketConstructor } from './standard-connect'
export { createStandardSocketOpener } from './standard-connect'
export type { UpgradeResponse, UpgradeSocket } from './upgrade'
export { acceptUpgrade, upgradeHeaders } from './upgrade'
export type { CloseReason, PlatformEvent, PlatformSocket, WsLike } from './ws-shim'
export { toWsLike } from './ws-shim'
