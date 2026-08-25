# @pleaseai/harness-cf-transport

Opens the [AI SDK harness](https://ai-sdk.dev/docs/ai-sdk-harnesses) bridge socket over a
Cloudflare Sandbox, so `@ai-sdk/harness-claude-code` never reaches for the `ws` package.

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
| `toWsLike(socket)` | a platform `WebSocket` wearing the `ws` API the harness drives |

Two details are load-bearing, both read off the adapter rather than assumed: the bridge
credential travels in the URL's **query string** (`agent_bridge_token`), and an accepted
socket never fires `open`, which the adapter waits for — so the shim synthesises it.
