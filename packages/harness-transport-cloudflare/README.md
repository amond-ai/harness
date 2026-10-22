# @amond-ai/harness-transport-cloudflare

Opens the [AI SDK harness](https://ai-sdk.dev/docs/ai-sdk-harnesses) bridge socket over a
Cloudflare Sandbox, so `@ai-sdk/harness-claude-code` never reaches for the `ws` package.

The socket *shape* and the standard-`WebSocket` opener live in `@amond-ai/harness-transport`, which
runs anywhere. This package is only what Cloudflare needs on top: a sandbox's bridge port is
private, so it cannot be dialed by URL at all — it is reached by sending the upgrade `Request` to
the sandbox's Durable Object (`HarnessSandbox` from `@amond-ai/sandbox-cloudflare`), which means
headers, which the standard constructor cannot send.

## Why

`ws` cannot run in a Worker. workerd resolves its `browser` export condition to a stub that
throws, so `import { WebSocket } from 'ws'` yields `undefined` while the import still
succeeds — a load-only check is a false green. Forcing ws's node entry through a wrangler
`alias` bundles but throws at construction, because workerd's `node:http` `ClientRequest`
does not implement `options.createConnection`. Both halves are measured in
`apps/cf-orchestrator/test/workerd-spike/`.

The Durable Object hands out a working socket from its `fetch()`: it reads the port from
`SANDBOX_PORT_HEADER`, forwards the upgrade with `ctx.container.getTcpPort(port)`, and relays the
socket so the open bridge keeps the container alive. That is Cloudflare's documented replacement
for 0.x's `Sandbox.wsConnect(request, port)`, which `@cloudflare/sandbox` 1.0 removed, and it
keeps the bridge port private rather than publishing it.

## What it provides

| Export | Purpose |
| --- | --- |
| `createBridgeSocketOpener(stub)` | `HarnessV1PortEndpoint` → an open, `ws`-shaped socket, through a Durable Object stub's `fetch` |
| `SANDBOX_PORT_HEADER` | the header that names the container port on a request to the Durable Object |
| `createDirectSocketOpener(fetch)` | the same, dialed straight over a `fetch` upgrade |
| `createWebSocketClass(…)` | a `WebSocket`-shaped class for code that constructs one itself |
| `sandboxRoutedUrl(sandboxId, port, protocol = 'http')` | the `localhost` URL tagged with `SANDBOX_ID_PARAM` that a backend returns for a port this transport routes through the sandbox; throws on an empty id |
| `openSandbox(namespace, sandboxId)` from `./sandbox` | the Durable Object stub for an id — `namespace.getByName(sandboxId.toLowerCase())`, the one spelling of 0.x's `normalizeId: true` every caller shares |

Two details are load-bearing, both read off the adapter rather than assumed: the bridge
credential travels in the URL's **query string** (`agent_bridge_token`), and an accepted
socket never fires `open`, which the adapter waits for — so the shim synthesises it.

## Upstream

This package exists because the AI SDK's bridge adapters dial the endpoint URL with a stock
`ws` client. If the provider rule in
[vercel/ai#17638](https://github.com/vercel/ai/issues/17638) changes to allow a
provider-supplied socket opener, check whether this package is still needed.
This repository tracks the upstream provider issues in
[amond-ai/harness#64](https://github.com/amond-ai/harness/issues/64).
