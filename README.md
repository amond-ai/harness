# harness

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

Run an agent harness inside an isolated sandbox, from any JavaScript runtime.

`harness` is a set of TypeScript packages that start one Claude Code turn in a sandbox, watch
it, attach to it over a WebSocket, and stop it. The orchestrator that calls it can be a
Cloudflare Worker, a Vercel function, a Deno desktop app, or a Node or Bun process. The sandbox
can be any backend that satisfies the `@amond-ai/sandbox` contract. The Claude Code turn itself
runs through the Agent SDK in a small host process inside the sandbox, so the caller gets a
typed result, can interrupt a turn cleanly, and can answer a tool approval or send a message
while the turn is running.

The code is being extracted from software-factory, an internal PassionFactory project, where
it runs in production behind a Cloudflare Workflows run loop. Until the move lands, the
sources live there under `packages/`; this repository holds the packages once they are lifted
out.

## Packages

| Package | Runs where | What it does |
| --- | --- | --- |
| `@amond-ai/harness-claude-code` | the orchestrator | The `TurnDriver` seam and both Claude Code drivers: `sdk` (drives the turn host over the bridge socket, one bounded attach round at a time) and `cli` (execs `claude -p` in the sandbox and watches its log cursor). Runtime-neutral. |
| `@amond-ai/harness-bridge-runtime` | inside the sandbox image | The transport every bridge shares: a token-gated WebSocket server, the monotonic `seq`, the disk-first journal and the resume replay over it, and the `abort`/`interrupt`/`stop`/`destroy` commands. Knows no agent — that arrives as `onStart`. A fork of Vercel's `@ai-sdk/harness` bridge (Apache-2.0). |
| `@amond-ai/harness-claude-code-bridge` | inside the sandbox image | The Claude adapter on that runtime: the per-turn Node process that hosts the Agent SDK `query()`. A fork of Vercel's `@ai-sdk/harness-claude-code` bridge (Apache-2.0). |
| `@amond-ai/harness-codex-bridge` | inside the sandbox image | The Codex adapter on that runtime: the per-turn Node process that hosts `@openai/codex-sdk`, running its thread under `approvalPolicy: 'never'`. A fork of Vercel's `@ai-sdk/harness-codex` bridge (Apache-2.0). |
| `@amond-ai/harness-protocol` | both | The bridge wire schema: every frame a host emits and the orchestrator sends, as zod schemas. One entry point per harness — the root is Claude's, `./codex` is Codex's — so each sandbox bundle carries only its own adapter's schemas. |
| `@amond-ai/harness-transport` | the orchestrator | The `WsLike` socket shape, the upgrade headers, and a socket opener built on the standard `WebSocket` constructor. Deno, Node 22+, Bun, and browsers dial with this. |
| `@amond-ai/harness-transport-cloudflare` | Cloudflare Workers | The opener for a Cloudflare Sandbox, whose ports are private and reached through `Sandbox.wsConnect`, plus the workerd `fetch` upgrade path. |
| `@amond-ai/sandbox` | both | The sandbox contract: `SandboxProvider`, `SandboxSession`, `SandboxProcessHandle`, files, logs, and `portEndpoint`. No dependencies. |
| `@amond-ai/sandbox-e2b` | the orchestrator | An e2b backend for the contract. Journals a process's output to the sandbox filesystem so it survives the process and a reconnect. |
| `@amond-ai/sandbox-local` | the orchestrator | A local-process backend for the contract, for a desktop app that runs on the user's own machine. Journals the transcript, pid and exit status to disk and verifies liveness against the kernel, so a relaunched app finds the turn it started. Not an isolation boundary. |
| `@amond-ai/sandbox-vercel` | the orchestrator | A Vercel Sandbox backend for the contract. Journals a process's output to the sandbox filesystem, because Vercel forgets a command across a session resume and exposes no process list at all. |
| `@amond-ai/redact` | both | Credential masking for every diagnostic the packages emit, and the bound-then-scrub used for stored error summaries. |

The packages depend only on each other and on published external packages. A test in
`harness-claude-code` asserts that on every run, so the set can move between repositories
without a rewrite.

## How a turn runs

```text
orchestrator (any JS runtime)                  sandbox (e2b, Cloudflare, ...)
┌──────────────────────────────┐               ┌──────────────────────────────┐
│ TurnDriver.start(turn)  ───── exec ─────────▶ │ harness-claude-code-bridge   │
│   waits for bridge-ready     │               │   query() from the Agent SDK │
│ TurnDriver.awaitRound(...) ── WebSocket ────▶ │   ws server, token-gated     │
│   frames in, commands out    │ ◀── frames ── │   event-log.ndjson (seq)     │
│ TurnDriver.kill(handle)      │               │   claude CLI as a subprocess │
└──────────────────────────────┘               └──────────────────────────────┘
```

1. The driver execs the host in the sandbox with the turn's environment and waits for the
   host to print `bridge-ready` with its port.
2. The driver dials that port. The per-turn token rides the URL query, so a plain `WebSocket`
   is enough; a Cloudflare Sandbox is dialed through `wsConnect` because its port is private.
3. The driver sends `start` with the prompt and options. The host runs `query()` and emits
   every SDK message as a frame with a sequence number, appending each to a journal on disk
   before sending it.
4. The driver consumes frames for one bounded round and returns what the next round resumes
   from. A reconnect sends `attach { since }` and the host replays the journal after that
   sequence, so a dropped socket or an evicted orchestrator step loses nothing.
5. `interrupt` asks the SDK to stop and still yields a typed `result`. A tool the policy
   defers ends the turn as `deferred`, and the same session resumes after a person answers.

## Quick start

Install the driver, a socket opener for your runtime, and a sandbox backend:

```bash
bun add @amond-ai/harness-claude-code @amond-ai/harness-transport @amond-ai/sandbox-e2b
```

Every package is published under `@amond-ai`, as ESM, for Node 22 or newer. Which *other*
runtimes a package runs on differs by package — [Runtimes](#runtimes) is the authority. Two
members do not travel: the bridge is a Node process for the sandbox image, and `sandbox-local`
spawns processes on the host, so neither belongs in a Worker.

The driver decides nothing about your platform. You give it a sandbox provider, a way to open
a socket, how to invoke `claude`, where to publish the transcript, and the thresholds to judge
a turn by.

```ts
import { turnDriver } from '@amond-ai/harness-claude-code'
import { createStandardSocketOpener } from '@amond-ai/harness-transport'
import { createE2bProvider } from '@amond-ai/sandbox-e2b'

const provider = createE2bProvider({ apiKey: process.env.E2B_API_KEY })
const openSocket = createStandardSocketOpener()

const config = {
  watchdogTimeoutMs: 10 * 60_000,
  livenessWindowMs: 5 * 60_000,
  livenessSampleIntervalMs: 30_000,
  turnWallClockBudgetMs: 5 * 60 * 60_000,
  turnDeferTools: [],
  turnRefuseTools: [],
  workspaceRoot: '/workspace',
}

const driver = turnDriver(provider, {
  kind: 'sdk',
  sandboxId,
  runId,
  config,
  openSocket: url => openSocket({ url }),
  claudeArgv: turn => ['claude', '-p', turn.prompt, '--output-format', 'stream-json'],
  settingSources: ['user', 'project'],
})

const handle = await driver.start({
  prompt,
  permissionMode: 'acceptEdits',
  attempt: 1,
  cwd: '/workspace/repo',
  env: () => ({ ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY! }),
  recordedProcessId: undefined,
  started: [],
  sessionId,
})

let previous
for (let round = 0; ; round++) {
  const state = await driver.awaitRound(handle, { config, mirror: undefined, round, previous })
  if (state.outcome) {
    break
  }
  previous = state
}
```

On Cloudflare, replace `openSocket` with the opener from
`@amond-ai/harness-transport-cloudflare`, which routes a tagged endpoint through the Sandbox
binding. The sandbox image must contain the `claude` CLI, the host bundle, and an Agent SDK
whose version equals the CLI's.

## Runtimes

| Runtime | Driver | Socket opener | Sandbox provider |
| --- | --- | --- | --- |
| Cloudflare Workers | `harness-claude-code` | `harness-transport-cloudflare` | Cloudflare Sandbox (in the consuming app today), e2b |
| Vercel (Node) | `harness-claude-code` | `harness-transport` | Vercel Sandbox, e2b |
| Deno desktop | `harness-claude-code` | `harness-transport` | local process, e2b; Docker is planned |
| Node, Bun | `harness-claude-code` | `harness-transport` | local process, e2b |

The only runtime-specific packages are the Cloudflare transport and the two halves of the host —
the shared bridge runtime and the Claude adapter on it — which run on Node inside the image, plus
one module of `sandbox-local`, whose subject is the machine and which therefore cannot be written
without host primitives. Everything else has no `node:`, `bun:`, or `cloudflare:` import, and
`closure.test.ts` asserts exactly that on every run.

## What a consumer injects

| Injection | Where | Why the driver does not decide it |
| --- | --- | --- |
| `SandboxProvider` | `turnDriver(provider, …)` | Which backend, and it is resolved per use. |
| `openSocket(url)` | `TurnDriverRun.openSocket` | Dialing is the one part that differs per runtime. |
| `claudeArgv(turn)` | `TurnDriverRun.claudeArgv` | Flags, plugins, and settings sources are your policy. `cli` driver only. |
| `settingSources` | `TurnDriverRun.settingSources` | The same list as the `sdk` host's `start` frame carries it. |
| `LiveMirror` | `TurnAwaitSpec.mirror`, `TurnRoundSpec.mirror` | Where the transcript goes and how it is masked. |
| `TurnDriverConfig` | `TurnDriverRun.config` | Liveness, watchdog, wall-clock budget, per-turn ceilings, tool policy, workspace root. |

Credentials enter only through the `env` thunk on `start`, and only on the exec path. The
driver adds no token, opens no public port without the bridge token, and never puts the prompt
in argv on the `sdk` path.

## Status

Pre-1.0. The packages are exercised by the software-factory orchestrator on Cloudflare with e2b
and Cloudflare Sandbox backends. The Vercel Sandbox backend satisfies the same contract and is
covered by its own suite against a fake, but has not yet been run against a live Vercel sandbox.
Docker and a harness-neutral core package are planned once a second harness exists.

## Development

```bash
bun install
bun run build      # tsdown, per package, into dist/
bun run check      # tsc across the workspace
bun run lint
bun run test
```

A package's `exports` point at `dist/`, so a package has to be built before anything resolves
it. `test` depends on its own package's `build`; `check` depends only on its **dependencies'**
builds, so `bun run check` alone does not build the package you are checking — run `build`
yourself when you want to inspect what a package ships. The host bundle for the sandbox image
is built with `bun build` targeting Node instead; the image build asserts that
`claude --version` equals the Agent SDK's bundled version and fails on a mismatch.

## Releasing

Versions and changelogs are release-please's, driven by
[Conventional Commits](https://www.conventionalcommits.org/) on `main`. Merging the release PR
tags every package it bumped, and the same workflow then publishes exactly those packages to
npm — the tarball packed by bun, published by the npm CLI through npm's trusted publishing, so
each version carries a provenance attestation tied to this repository, the release commit, and
that workflow run. There is no npm token to hold: the registry mints the credential from the
workflow's own OIDC identity.

```bash
npm view @amond-ai/harness-claude-code dist.attestations   # provenance present?
```

[`scripts/publish.ts`](scripts/publish.ts) is what that workflow runs, and it is the same
command by hand:

```bash
bun scripts/publish.ts --dry-run    # pack every package, publish nothing
bun scripts/publish.ts              # publish what is not on the registry yet
```

A publish run by hand needs `npm login` and produces **no attestation** — provenance requires
the OIDC token only GitHub Actions can mint, so the script requests it there and nowhere else.
Use the local path for the first release of a package, before npm has a trusted publisher to
mint a credential from; everything after that belongs to the workflow.

## Contributing

Bugs go to [Issues](https://github.com/amond-ai/harness/issues/new/choose); feature proposals go
to [Discussions](https://github.com/amond-ai/harness/discussions/categories/ideas). See
[CONTRIBUTING.md](./CONTRIBUTING.md) for the setup, commit, and pull-request process, and
[CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) for community standards. Report vulnerabilities
privately through [SECURITY.md](./SECURITY.md), not a public issue.

## License

Apache-2.0. `harness-bridge-runtime`, `harness-claude-code-bridge`, `harness-codex-bridge` and
`harness-protocol` contain code derived from [vercel/ai](https://github.com/vercel/ai)
(`@ai-sdk/harness`, `@ai-sdk/harness-claude-code`, `@ai-sdk/harness-codex`), Apache-2.0; the
exact upstream commit and the patches carried on top are listed in each package's `UPSTREAM.md`.
