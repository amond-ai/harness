# `@amond-ai/harness-claude-code`

One Claude Code turn, run inside a sandbox: started, watched, attached to, and stopped.

The driver itself runs wherever a standard `WebSocket` and `fetch` do — Deno, Node, Bun, workerd.
What is platform-specific is on either side of it: the *sandbox provider* that supplies the
container (`@amond-ai/sandbox-e2b` today; Cloudflare's lives in `apps/cf-orchestrator`; Vercel
Sandbox, Docker and a local process are follow-ups), and the *socket opener* that dials the turn
host. Most runtimes need neither package — `createStandardSocketOpener()` from
`@amond-ai/harness-transport` dials with the platform's own `WebSocket`.

## The seam

`TurnDriver` is a tagged union over the two ways a turn can be run, because the two ways to
*wait* are genuinely different:

- **`cli`** — the `claude` CLI exec'd in the container, watched by sampling its log cursor and
  stopped with SIGINT escalating to the backend's kill. It waits once (`mode: 'single'`,
  `await`), racing the process's exit against a liveness watchdog.
- **`sdk`** — the Agent SDK turn host (`@amond-ai/harness-claude-code-bridge`), attached to over a WebSocket for
  one bounded round at a time (`mode: 'rounds'`, `awaitRound`), so a six-hour turn stays under a
  per-step CPU meter and an eviction costs one round rather than the turn.

`turnDriver(provider, run)` builds one from a `TurnDriverKind` re-parsed at the boundary; an
unknown name throws rather than silently running the incumbent.

Nothing here imports `cloudflare:workers` or `@cloudflare/sandbox` — that is the point of the
injection points below, and the package's own test suite runs in-process.

## What a consumer injects

| Injection | Where | Why it is not decided here |
|---|---|---|
| `SandboxProvider` | `turnDriver(provider, …)` | Which container, on which backend — and it is resolved *per use*, never held across a step. |
| `openSocket(endpoint)` | `TurnDriverRun.openSocket` | How a bridge endpoint is dialed: the standard `WebSocket` on most runtimes, `@amond-ai/harness-transport-cloudflare` where the port is private and reachable only through `wsConnect`. |
| `claudeArgv(turn)` | `TurnDriverRun.claudeArgv` | What a `claude` turn is invoked with — flags, plugins, settings sources — is the deployment's policy. `cli` only. |
| `settingSources` | `TurnDriverRun.settingSources` | The same list, as the `sdk` host's `start` frame carries it. |
| `LiveMirror` | `TurnAwaitSpec.mirror` / `TurnRoundSpec.mirror` | Where the turn's bytes are published (R2, a file, nothing) and how they are masked. |
| `TurnDriverConfig` | `TurnDriverRun.config`, and each wait's spec | The thresholds a turn is judged by: liveness, watchdog, wall-clock budget, per-turn ceilings, tool policy, workspace root. |

## Use it through the AI SDK

`createClaudeCode()` wraps the same driver as a `HarnessV1` adapter, so `HarnessAgent` from
`@ai-sdk/harness` can run a turn — and suspend one at a round boundary — without knowing that a
turn host, a bridge socket or an attach cursor exist.

```ts
import { HarnessAgent } from '@ai-sdk/harness/agent'
import { createClaudeCode } from '@amond-ai/harness-claude-code'
import { createHarnessSandboxProvider } from '@amond-ai/harness-sandbox'

const agent = new HarnessAgent({
  harness: createClaudeCode({
    // `sandboxes` is an @amond-ai/sandbox provider, `openSocket` dials a bridge endpoint,
    // `config` is the TurnDriverConfig thresholds, and `env` is the only way a credential
    // reaches a turn.
    sandboxes,
    openSocket,
    config,
    settingSources: ['project'],
    env: () => ({ ANTHROPIC_API_KEY: apiKey }),
  }),
  sandbox: createHarnessSandboxProvider({ sandboxes }),
})

const session = await agent.createSession({ sessionId: runId, sandboxSession })
const { text } = await agent.generate({ session, prompt })
```

A slice boundary is `session.suspendTurn()` → `agent.createSession({ continueFrom })` →
`agent.continueGenerate({ session })`: the host keeps running, and the next slice attaches at the
cursor the last one stopped at, so nothing is lost and nothing is replayed twice.

The adapter ships no `getBootstrap` — the sandbox image already contains the turn host bundle.

What v1 deliberately does not do:

- **Builtin-tool approvals.** `builtinTools` is empty and `supportsBuiltinToolApprovals` is unset;
  the host's `deferred` outcome is not yet mapped onto `tool-approval-request`.
- **`submitToolResult` / `submitUserMessage`.** Host-executed tools and mid-turn messages need a
  channel the driver does not expose; `submitToolResult` throws
  `HarnessCapabilityUnsupportedError` and `submitUserMessage` is absent.
- **`doCompact`.** The Agent SDK compacts its own context; a manual trigger throws.
- **The `cli` kind.** It waits for a turn in one window, so there is no round boundary to suspend
  at; `doStart` refuses it.

## The closed set

This package and its siblings are meant to be liftable into a repository of their own, so the
whole set depends only on itself plus external (catalog) dependencies:

| Package | What it contributes |
|---|---|
| `@amond-ai/harness-claude-code` | This package: the seam and both drivers. |
| `@amond-ai/sandbox` | The container surface a driver runs against — `exec`, `logs`, `kill`, `portEndpoint`. |
| `@amond-ai/harness-protocol` | The turn host's wire schema, which the `sdk` driver's frames are parsed by. |
| `@amond-ai/harness-transport` | The `WsLike` socket shape, the upgrade handshake, and the standard-`WebSocket` opener. |
| `@amond-ai/harness-transport-cloudflare` | The opener a Worker needs instead, because a Sandbox port is private. |
| `@amond-ai/redact` | Credential masking, applied to every diagnostic any of this emits. |
| `@amond-ai/harness-claude-code-bridge` | The process the `sdk` driver drives, running inside the sandbox image. |
| `@amond-ai/sandbox-e2b` | One backend satisfying `@amond-ai/sandbox`, so the set is runnable off Cloudflare. |

Nothing in the set may depend on `apps/*`, `@pleaseai/agent-core`, `@pleaseai/sandbox-bridge`,
`@pleaseai/dashboard-schema` or `@pleaseai/session-store`. `src/closure.test.ts` asserts it on
every run. External dependencies are unconstrained — `harness-transport-cloudflare` keeps
`@cloudflare/sandbox` and `sandbox-e2b` keeps `e2b`, both of which travel with their manifests.
Runtime coupling is constrained, though: only `harness-transport-cloudflare`,
`harness-bridge-runtime` and `harness-claude-code-bridge` may name a runtime, and the same test
holds every other member to no `@cloudflare/*` dependency and no `cloudflare:`/`node:`/`bun:`
import — with one module-level exception, `sandbox-local/src/node-host.ts`. That exception makes
`sandbox-local` host-process-only rather than portable: its package entry re-exports
`nodeLocalHost`, so importing it loads the `node:` builtins even though every other file in the
package is written against the structural `LocalHost` surface.

Everything Pleaseworks-specific stays in `apps/cf-orchestrator` and arrives through the
injection points above: the `software-factory` plugin id and the rest of the `claude` flags
(`claudeArgv`), `TURN_SETTING_SOURCES` (`settingSources`), the wrangler `Env` and its parsing
(`TurnDriverConfig`), the R2 bucket and the transcript masking policy (`LiveMirror`), and
`@cloudflare/sandbox` itself (`openSocket`).
