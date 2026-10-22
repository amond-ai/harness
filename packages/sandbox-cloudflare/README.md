# @amond-ai/sandbox-cloudflare

A [Cloudflare Sandbox](https://developers.cloudflare.com/sandbox/) backend for
[`@amond-ai/sandbox`](../sandbox), built on `@cloudflare/sandbox` 1.0.

```ts
import { createHarnessSandboxProvider } from '@amond-ai/harness-sandbox'
import { createCloudflareProvider } from '@amond-ai/sandbox-cloudflare'
import { env } from 'cloudflare:workers'

export { HarnessSandbox } from '@amond-ai/sandbox-cloudflare'

const sandboxes = createCloudflareProvider(env.Sandbox)

// The same provider, handed to the AI SDK harness as its sandbox.
const harnessSandbox = createHarnessSandboxProvider({
  sandboxes,
  defaultWorkingDirectory: '/workspace',
  ports: [30_000],
})
```

`env.Sandbox` is the Durable Object namespace bound to `HarnessSandbox` in your
`wrangler.jsonc`.

## What the package ships

`@cloudflare/sandbox` 1.0 no longer ships a `Sandbox` Durable Object or a client with a process
table: the application writes its own Durable Object and drives the container through
`ctx.container`. This package is that Durable Object plus the mapping layer onto the contract, so
Cloudflare is now a mapped backend like e2b and Daytona.

| Piece | What it does |
| --- | --- |
| `HarnessSandbox` | The Durable Object. Starts the container (`images.sandbox`, `standard-1`, Internet on, five-minute inactivity timeout), runs processes with Cloudflare's [background-process pattern](https://developers.cloudflare.com/sandbox/commands/run-background-processes/), serves files through `Files`, and forwards bridge connections into the container. |
| `createCloudflareProvider(namespace)` | `session(id)` resolves `namespace.getByName(id.toLowerCase())` synchronously and maps the contract onto the object's RPC methods. |
| Port endpoint | A `localhost` URL tagged with `SANDBOX_ID_PARAM`, built by `sandboxRoutedUrl` from `@amond-ai/harness-transport-cloudflare`. The transport sends the upgrade to `HarnessSandbox.fetch` with the port in `SANDBOX_PORT_HEADER`, and the object forwards it with `getTcpPort`. Building the URL does no I/O. |

How the contract maps:

- **Processes.** Each process gets `/var/lib/processes/<id>/` with `pid`, `stdout.log`,
  `stderr.log`, `exit-code` and `meta.json`. The command runs under `setsid`, so `kill()` signals
  its whole group: SIGTERM by default, or the named signal (`kill(2)` sends SIGINT). An alarm
  keeps the container running while any process does.
- **Exit codes.** The status is reported as recorded. A signalled command's `128 + n` is not
  decoded into `signal`, because `exit 143` records the same number.
  `timedOut` is true only when `exec`'s own `timeout` ended the process.
- **Discovery.** `getProcess` and `listProcesses` answer `null` and `[]` from a stopped container
  without starting one. `exists` starts it. `destroy` never does.
- **Files.** `writeFile` creates missing parent directories, as 0.x did. A read defaults to
  `utf-8`; pass `encoding: 'base64'` for bytes.

### Overriding the defaults

Consumers never construct the Durable Object, so it is configured by subclassing:

```ts
import { HarnessSandbox } from '@amond-ai/sandbox-cloudflare'

export class Sandbox extends HarnessSandbox<Env> {
  protected override inactivityTimeoutMs(): number {
    return 30 * 60 * 1000
  }

  protected override async setupContainer(container: Container): Promise<void> {
    // Runs for each new container and after the object restarts; must be safe to repeat.
    // GIT_CREDENTIALS stands for a Fetcher binding your Worker defines; this package has none.
    await container.interceptOutboundHttps('github.com', this.env.GIT_CREDENTIALS)
  }
}
```

`containerOptions()` returns the options passed to `container.start()`.

## Migrating from `@cloudflare/sandbox` 0.x

Read Cloudflare's [migration guide](https://developers.cloudflare.com/sandbox/sdk/migrate/) first.
The steps below are what changes for a Worker that used this package on `@cloudflare/sandbox` 0.x.

1. **Export the new class.** Replace `export { Sandbox } from '@cloudflare/sandbox'` with
   `export { HarnessSandbox } from '@amond-ai/sandbox-cloudflare'`. To keep the binding and its
   storage, keep the class name: `export { HarnessSandbox as Sandbox } from '@amond-ai/sandbox-cloudflare'`.
2. **Change the `containers` entry** for that class:

   ```jsonc
   {
     "compatibility_date": "2025-11-17",
     "compatibility_flags": ["nodejs_compat"],
     "containers": [
       {
         "class_name": "Sandbox",
         "name": "my-worker-sandbox-v1",
         "scheduling_policy": "durable_object",
         "images": { "sandbox": { "dockerfile": "./Dockerfile" } }
       }
     ]
   }
   ```

   - `scheduling_policy: "durable_object"` lets each object start its own container.
   - Give the container application a `name` your account has not used. Without one, the deploy
     fails after the new Worker version is already live.
   - Remove `image`, `instance_type` and `max_instances`; this policy rejects them. The image
     moves to `images.sandbox`.
   - Keep `nodejs_compat`, and use a compatibility date of `2025-11-17` or later.
   - Leave `durable_objects` and `migrations` as they are.
3. **Replace the image base.** `FROM docker.io/cloudflare/sandbox` no longer applies. Start from
   an image with the tools the agent needs, and copy in `sandbox-shim`, which `Files` needs:

   ```dockerfile
   FROM node:24-trixie-slim
   # git for the agent; coreutils (dd, head, wc) and util-linux (setsid) for the process scripts.
   RUN apt-get update \
     && apt-get install -y --no-install-recommends ca-certificates git coreutils util-linux \
     && rm -rf /var/lib/apt/lists/*
   COPY --from=docker.io/cloudflare/sandbox:1.0.2 /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
   WORKDIR /workspace
   CMD ["sleep", "infinity"]
   ```

   `procps` is not needed: `kill` is a shell builtin. Keep the `sandbox-shim` tag in step with the
   installed `@cloudflare/sandbox`. Commands do not see `ENV` lines, so pass values through
   `exec`'s `env` option instead.
4. **Remove 0.x options.** `SANDBOX_OPTIONS` is gone from `@amond-ai/harness-transport-cloudflare`.
   Its `normalizeId: true` is now the lowercasing in `openSandbox`, and its `sleepAfter: '5m'` is
   `HarnessSandbox`'s inactivity timeout. Outbound rules such as `Sandbox.outboundByHost` move to
   `setupContainer()`; see Cloudflare's
   [outbound traffic](https://developers.cloudflare.com/sandbox/sdk/migrate/outbound-traffic/) page.

Before you deploy, know what the switch does:

- **It is one-way.** After the deploy that moves the class to `scheduling_policy: "durable_object"`,
  0.x code cannot start containers for it, even after `wrangler rollback`.
- **In place or side by side.** Keeping the class name moves every sandbox in one deploy.
  Commands running in 0.x containers end, and files in them do not carry over: a run that was
  mid-turn has to start again. For long-lived sandboxes, Cloudflare describes
  [moving side by side](https://developers.cloudflare.com/sandbox/sdk/migrate/move-side-by-side/)
  under a new class name instead.
- **0.x support ends on 2026-12-31.** Until then it receives bug and security fixes only.

## What it does not supply

The contract does not express a credential path for repository access, and neither does this
package. On Cloudflare the consuming Worker supplies it out of band, by intercepting the
container's egress from a `HarnessSandbox` subclass (`setupContainer()` above); see
[`@amond-ai/sandbox`](../sandbox#what-a-backend-must-supply).

## License

Apache-2.0. See [LICENSE](./LICENSE).
