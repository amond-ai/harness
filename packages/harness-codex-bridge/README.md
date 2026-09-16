# @amond-ai/harness-codex-bridge

The per-turn host that runs **inside the sandbox image**: it hosts
[`@openai/codex-sdk`](https://www.npmjs.com/package/@openai/codex-sdk) and serves the
orchestrator over a WebSocket, appending each transcript frame to a sequence-numbered journal on
disk before it sends it.

Every turn event is journaled, the text and reasoning deltas included. That is the one place this
bridge differs from
[`@amond-ai/harness-claude-code-bridge`](../harness-claude-code-bridge), which sends its deltas
live-only: there the same text arrives again on a `raw` frame carrying the whole SDK message, so
a delta is a duplicate. Codex emits no `raw` frames, so here the deltas *are* the transcript and
a reconnect has to get them back.

Two things fall outside that, and both are the runtime's rather than this host's. An append the
filesystem refuses costs that one entry on disk rather than the turn: the frame is in the
in-memory log before the append is queued, so a `resume` against this process still replays it and
only a reader that arrives after a restart misses it. And a control frame the runtime answers a
socket with directly, such as a `start` refused because a turn is already running, never goes
through the journal at all.

This package ships one artifact — `dist/bridge.mjs`, a Node bundle. It is not a library: the
orchestrator never imports it, it *execs* it. The transport underneath is
[`@amond-ai/harness-bridge-runtime`](../harness-bridge-runtime) and the wire schema is
[`@amond-ai/harness-protocol`](../harness-protocol)'s `./codex` entry point.

## Baking it into an image

The bundle leaves three dependencies external, so they resolve from the image's own
`node_modules` and the SDK the turn runs on is the one the image pins:

- `@openai/codex-sdk`
- `ws`
- `zod`

```dockerfile
RUN npm install --global @amond-ai/harness-codex-bridge@<version> \
 && cp "$(npm root -g)/@amond-ai/harness-codex-bridge/dist/bridge.mjs" /opt/turn-host/codex-bridge.mjs
# Pin all three. Unpinned, a rebuild pairs this bundle with whatever npm calls latest.
# The versions this bundle is built against are the repository root's `sandbox-image`
# catalog (`@openai/codex-sdk`, `ws`) and its `zod` entry. `@openai/codex-sdk` depends on
# `@openai/codex`, the CLI it spawns, so pinning the SDK pins the CLI with it — there is no
# second pin to keep in step the way the Claude bridge has.
RUN npm install --prefix /opt/turn-host \
      @openai/codex-sdk@<version> ws@<version> zod@<version>

# The image build's smoke test: loads the bundle and the real SDK, prints both versions, exits 0.
RUN node /opt/turn-host/codex-bridge.mjs --version
```

`--version` is what fails the *build* — rather than a turn, mid-run in a sandbox — when the
bundle cannot resolve its runtime dependencies.

## How a turn reaches it

The host takes `--workdir` and `--bridge-state-dir`, binds the port it is told to, prints
`bridge-ready` with that port, and gates the socket on the per-turn token. From there the
orchestrator sends `start`, consumes frames for one bounded round, and reconnects with
`resume { lastSeenEventId }` — the journal replays every frame after that sequence, so a dropped
socket loses no transcript.

A turn ending **does not end the process**: `stop` and `destroy` are the ordinary way it exits,
so the same host serves the next turn. `stop` answers with the thread id, which is also
announced mid-turn on `bridge-thread` — a process that dies still leaves the client a thread to
resume, and a later `start` picks it up with `resumeThreadId`.

## What the turn runs as

Three settings are fixed rather than taken from `start`, and the wire schema is written around
them:

- **`approvalPolicy: 'never'`.** Load-bearing, not a default. `codexTurnHostFinishSchema`
  has no `deferredToolUse` *because* of this: a turn under this policy cannot park on a
  decision, so there is no deferral for an ending to name. A bridge that wants approvals needs
  the schema changed first.
- **`sandboxMode: 'danger-full-access'`.** The sandbox is the isolation boundary, not the CLI.
  A `start` whose `permissionMode` names something narrower is refused rather than run with more
  access than it asked for.
- **`skipGitRepoCheck: true`.** The workdir is whatever the orchestrator prepared.

`start.tools` and `start.builtinToolFiltering` are refused for the same reason: this host has no
way to honour either, and a turn that silently ran without the tools it asked for is worse than
one that did not run.

## Credentials

Whatever the process's environment holds is forwarded to the CLI child, and that is the only
route in — it is what the consumer's `env: () => Record<string, string>` thunk populated when the
sandbox exec'd this bridge. `CODEX_API_KEY` is passed straight to the SDK as its `apiKey`, the
credential the CLI's own configuration authenticates with; it selects no provider by itself.
`OPENAI_BASE_URL` or `start.headers` are the separate provider-selection path: either one stands
up a named `agent_bridge_openai` model provider pointed at that base URL (default
`https://api.openai.com/v1` when only `start.headers` is given, since headers can only attach to
a configured provider), reading its credential from the same `CODEX_API_KEY` variable and, when
`start.headers` is present, carrying it as that provider's per-request headers. With none of the
three set, the CLI falls back to its own configuration. Upstream's keyring-and-`auth.json`
subscription path is deliberately not ported — see [UPSTREAM.md](./UPSTREAM.md).

## Stopping a turn

`abort` and `interrupt` pull the same lever, because the Codex SDK has only one: the
`AbortSignal` its stream runs on. What differs is the ending. An `abort` is a teardown the client
asked for and gets no `finish`; an `interrupt` is remembered, and the turn is reported as a
`finish { stopped: 'interrupted', interruptedBy: … }` carrying what it produced before the stop.
There is no grace period and no escalation — unlike the Claude bridge, whose `query.interrupt()`
winds the CLI down and yields a typed result, here the abort *is* the escalation.

A turn that fails mid-run reports it the same way: `error { phase, interruptedBy? }`, with
`phase` naming which part of the turn was running and `interruptedBy` set only when the failure
landed during the wind-down of an interrupt. `journalPath` rides both `finish` and `error` flat,
per `codexTurnHostFinishSchema` / `codexTurnHostErrorSchema` in `@amond-ai/harness-protocol`'s
`./codex` entry point.

## Upstream

A fork of Vercel's `@ai-sdk/harness-codex` bridge (Apache-2.0).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
