# @amond-ai/harness-transport-cloudflare

Opens the [AI SDK harness](https://ai-sdk.dev/docs/ai-sdk-harnesses) bridge socket over a
Cloudflare Sandbox, so `@ai-sdk/harness-claude-code` never reaches for the `ws` package.

The socket *shape* and the standard-`WebSocket` opener live in `@amond-ai/harness-transport`, which
runs anywhere. This package is only what Cloudflare needs on top: a Sandbox's bridge port is
private, so it cannot be dialed by URL at all — it is reached through
`Sandbox.wsConnect(request, port)`, which means a `Request`, which means headers, which the
standard constructor cannot send.

## Why

`ws` cannot run in a Worker. workerd resolves its `browser` export condition to a stub that
throws, so `import { WebSocket } from 'ws'` yields `undefined` while the import still
succeeds — a load-only check is a false green. Forcing ws's node entry through a wrangler
`alias` bundles but throws at construction, because workerd's `node:http` `ClientRequest`
does not implement `options.createConnection`. Both halves are measured in
`apps/cf-orchestrator/test/workerd-spike/`.

Cloudflare hands out a working socket from `Sandbox.wsConnect(request, port)` — the same
upgrade pattern the SDK's own RPC control connection uses, and one that keeps the bridge port
private rather than publishing it with `exposePort`.

## What it provides

| Export | Purpose |
| --- | --- |
| `createBridgeSocketOpener(sandbox)` | `HarnessV1PortEndpoint` → an open, `ws`-shaped socket |
| `createDirectSocketOpener(fetch)` | the same, dialed straight over a `fetch` upgrade |
| `createWebSocketClass(…)` | a `WebSocket`-shaped class for code that constructs one itself |

Two details are load-bearing, both read off the adapter rather than assumed: the bridge
credential travels in the URL's **query string** (`agent_bridge_token`), and an accepted
socket never fires `open`, which the adapter waits for — so the shim synthesises it.
