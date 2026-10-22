# @amond-ai/sandbox-cloudflare

A [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) backend for
[`@amond-ai/sandbox`](../sandbox), and the only one that needs no mapping layer.

```ts
import { createHarnessSandboxProvider } from '@amond-ai/harness-sandbox'
import { createCloudflareProvider } from '@amond-ai/sandbox-cloudflare'
import { env } from 'cloudflare:workers'

export { Sandbox } from '@cloudflare/sandbox'

const sandboxes = createCloudflareProvider(env.Sandbox)

// The same provider, handed to the AI SDK harness as its sandbox.
const harnessSandbox = createHarnessSandboxProvider({
  sandboxes,
  defaultWorkingDirectory: '/workspace',
  ports: [30_000],
})
```

`env.Sandbox` is the Durable Object namespace bound to `@cloudflare/sandbox`'s `Sandbox` class in
your `wrangler.jsonc`.

## What the provider decides

The contract's shapes are structural copies of `@cloudflare/sandbox`'s, so `getSandbox(...)`'s
return value satisfies `SandboxSession` as it is. `session(id)` returns that client unchanged, and
`satisfies SandboxProvider` checks the provider at build time. If upstream diverges, the build
fails instead of the first replay in production.

The package decides only what each call site would otherwise write inline:

| Decision | Answer |
| --- | --- |
| Namespace | The one passed to `createCloudflareProvider`. |
| Boot options | `SANDBOX_OPTIONS`, applied by `openSandbox` from `@amond-ai/harness-transport-cloudflare/sandbox`. The transport's `ws` stand-in opens its sandbox through the same function, so an id resolves to the same container in both. You cannot override them, because a wrangler `alias` loads the stand-in and it cannot take configuration either. |
| Port endpoint | A `localhost` URL tagged with `SANDBOX_ID_PARAM`, built by `sandboxRoutedUrl` from `@amond-ai/harness-transport-cloudflare`, the same module that parses it. A Cloudflare sandbox's ports are private, so `@amond-ai/harness-transport-cloudflare` routes a tagged URL through `Sandbox.wsConnect` instead of dialing it. Building the URL does no I/O. |

## What it does not supply

The contract does not express a credential path for repository access, and neither does this
package. On Cloudflare the consuming Worker supplies it out of band, by intercepting the
container's egress with `Sandbox.outboundByHost`; see
[`@amond-ai/sandbox`](../sandbox#what-a-backend-must-supply).

## Upstream

The AI SDK tracks a first-party Cloudflare provider in
[vercel/ai#17638](https://github.com/vercel/ai/issues/17638). Its bridge rule asks for a URL a
stock `ws` client can dial, and a Cloudflare sandbox's private port gives none, so this package
backs the bridge adapters only together with
[`@amond-ai/harness-transport-cloudflare`](../harness-transport-cloudflare).
This repository tracks the upstream provider issues in
[amond-ai/harness#64](https://github.com/amond-ai/harness/issues/64).

## License

Apache-2.0. See [LICENSE](./LICENSE).
