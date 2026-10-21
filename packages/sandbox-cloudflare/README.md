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
| Boot options | `SANDBOX_OPTIONS` from `@amond-ai/harness-transport-cloudflare`, so an id resolves to the same container here and in the transport's `ws` stand-in. You cannot override them, because a wrangler `alias` loads the stand-in and it cannot take configuration either. |
| Port endpoint | A `localhost` URL tagged with `SANDBOX_ID_PARAM`. A Cloudflare sandbox's ports are private, so `@amond-ai/harness-transport-cloudflare` routes a tagged URL through `Sandbox.wsConnect` instead of dialing it. Building the URL does no I/O. |

## What it does not supply

The contract does not express a credential path for repository access, and neither does this
package. On Cloudflare the consuming Worker supplies it out of band, by intercepting the
container's egress with `Sandbox.outboundByHost`; see
[`@amond-ai/sandbox`](../sandbox#what-a-backend-must-supply).

## License

Apache-2.0. See [LICENSE](./LICENSE).
