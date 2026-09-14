# @amond-ai/harness-sandbox

The AI SDK harness's `HarnessV1SandboxProvider`, written **once** over
[`@amond-ai/sandbox`](../sandbox) — so every backend behind that contract gets one, with no
harness-shaped code in any of them.

```ts
import { createHarnessSandboxProvider } from '@amond-ai/harness-sandbox'
import { createE2bProvider } from '@amond-ai/sandbox-e2b'

const harnessSandbox = createHarnessSandboxProvider({
  sandboxes: createE2bProvider({ apiKey: process.env.E2B_API_KEY }),
  defaultWorkingDirectory: '/workspace',
  ports: [30_000],
})
```

`providerId` defaults to `pleaseai-<backend>`, so a diagnostic names the backend that produced
it. `newSessionId` is injected only so a test can pin the minted id.

## The translation, and where it stops

The contract is declared in Cloudflare's shape rather than the harness's, because that is the
shape a backend can satisfy with no mapping. The harness's own shape is a *further*
translation — and this package is where it lives, so the dozen modules of a backend never see
it.

Three surfaces make up the provider, and each is exported on its own for a backend that needs
only part of it:

| Export | What it translates |
| --- | --- |
| `createHarnessSandboxProvider` | `SandboxProvider` → `HarnessV1SandboxProvider` |
| `createHarnessSandboxSession` | `SandboxSession` → the harness's session |
| `createProcessSurface` | `SandboxProcessHandle` → the harness's process, including `splitProcessStreams` |
| `createFileSurface` | The contract's file calls → the harness's file surface |

`identity` — the framework's key for snapshot-based reuse — is ignored, because the contract
has no snapshot primitive to key anything on. A backend that grows one answers it there,
through the sandbox id it is already addressed by.

## License

Apache-2.0 — see [LICENSE](./LICENSE).
