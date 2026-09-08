/**
 * The alias target: `ws`, as far as the Worker bundle is concerned.
 *
 * Point wrangler's `alias` at this module and `@ai-sdk/harness-claude-code` opens its bridge
 * over a Cloudflare Sandbox — or over workerd's own `fetch` — instead of a TCP socket it
 * cannot create:
 *
 * ```jsonc
 * { "alias": { "ws": "@amond-ai/harness-transport-cloudflare/ws" } }
 * ```
 *
 * Kept apart from {@link createWebSocketClass} because this file is the one part that cannot
 * be unit-tested: `cloudflare:workers` resolves only inside a Worker build. Everything with a
 * decision in it lives in `ws-compat.ts`, which takes its sandbox lookup as an argument; this
 * is the wiring that supplies the real one.
 */
import type { WsClient } from './ws-compat'
import { getSandbox } from '@cloudflare/sandbox'
import { env } from 'cloudflare:workers'
import { createBridgeSocketOpener } from './cf-connect'
import { createDirectSocketOpener } from './direct-connect'
import { createWebSocketClass, SANDBOX_OPTIONS } from './ws-compat'

/**
 * Which binding holds the sandbox namespace.
 *
 * An aliased module is reached by import and never called, so it cannot be handed
 * configuration — this is read from the Worker's own vars instead, defaulting to the name the
 * Cloudflare Sandbox docs use. Resolved per connect rather than at module load, so a Worker
 * whose backend never mints a tagged URL needs no sandbox binding at all.
 */
const DEFAULT_BINDING = 'Sandbox'

function sandboxNamespace(): unknown {
  const bindings = env as unknown as Record<string, unknown>
  const name = typeof bindings.HARNESS_SANDBOX_BINDING === 'string'
    ? bindings.HARNESS_SANDBOX_BINDING
    : DEFAULT_BINDING
  const namespace = bindings[name]
  if (namespace == null) {
    throw new Error(
      `no sandbox binding '${name}' on this Worker: set HARNESS_SANDBOX_BINDING if the `
      + `namespace is bound under another name`,
    )
  }
  return namespace
}

/** Stands in for ws's `WebSocket`, which is the only value the adapter imports from `ws`. */
export const WebSocket: new (url: string, init?: { headers?: Record<string, string> }) => WsClient
  = createWebSocketClass({
    openSocket: async (sandboxId, endpoint) => {
      const sandbox = getSandbox(sandboxNamespace() as never, sandboxId, SANDBOX_OPTIONS)
      return createBridgeSocketOpener(sandbox)(endpoint)
    },
    dialDirect: createDirectSocketOpener((url, init) => fetch(url, init)),
  })

export default WebSocket
