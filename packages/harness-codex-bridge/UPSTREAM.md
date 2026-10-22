# Upstream

The turn host is a fork of Vercel's Codex bridge, vendored rather than depended
on: it must run inside the sandbox image against a pinned SDK, and the patches
below are not upstream yet.

- **Repository**: [vercel/ai](https://github.com/vercel/ai)
- **Commit**: `bb40cf03c5b68a4acee867d4fef9a65f71703c47`
- **Tag**: `@ai-sdk/harness-codex@1.0.160` (the same commit carries
  `@ai-sdk/harness@1.0.158` and `@ai-sdk/harness-claude-code@1.0.162`)
- **Packages taken from**: `@ai-sdk/harness-codex@1.0.160` (re-vendored from
  `1.0.113`), `@ai-sdk/harness@1.0.87`
- **License**: Apache-2.0 (both packages)

`@ai-sdk/harness-codex@1.0.160` comes from the same commit as the
`@ai-sdk/harness@1.0.158` that the shared halves both adapters compose on — the
copy under `harness-protocol/src/harness-v1/` and `harness-bridge-runtime` — are
vendored at (see their own `UPSTREAM.md`). The earlier `1.0.113` base was taken
from the published package rather than from a commit, and was already a later
release than the `@ai-sdk/harness@1.0.87` this host was first composed on: the
Codex half of upstream moves on its own. `harness-protocol` still pins
`codex-bridge-protocol.ts` at `1.0.111`. Up to `1.0.160` that file gained only the
deferred `prompt` field and a comment for the app-server's `thread/resume`, so the
`start` this host parses is the one it vendored.

The `1.0.113` → `1.0.160` re-vendor was a selective port, not a wholesale copy
of `src/bridge`:

- **Taken.** `7040da0` (1.0.120): a `web_search` call is held until a query
  exists, then emitted once per item id from `item.started` / `item.updated`. A
  search that never names a query is emitted at `item.completed` with
  `query: ''`, so its result still has a call to pair with. Patch 37 below holds
  a search without an id until `item.completed` as well. `76772ff` (1.0.131): an `mcp_tool_call` item that names a
  `server` is reported as `mcp__<server>__<tool>` on `tool-call`, `nativeName`
  and `tool-result`; an item without one keeps the bare tool name, as upstream
  does. The `mapUsage` fix: `noCache` is `input − cacheRead − cacheWrite`, floored
  at zero. The local `outputTokens` text/reasoning split and the
  `cache_write_input_tokens` read are kept; both are richer than upstream's.
- **Superseded.** `4d3c555` (failed native MCP calls surface as error tool
  results): already implemented here. The `mcp_tool_call` branch of
  `create-emit-stream-event.ts` sets `isError` on the `tool-result` from
  `item.status === 'failed' || item.error != null`, and
  `test/frames.test.ts` pins it. No patch number: nothing is carried over upstream.
- **Deferred to [#38](https://github.com/amond-ai/harness/issues/38).** `d17ead7`,
  the move to the Codex app-server, and what depends on it: `1bebfcf` (tools with
  `toModelOutput()`) and `184b9d3` (image prompts), together with the
  `native_tool` / `dynamic_tool_call` items and the step-tracker early finish.
- **Skipped.** Everything else: host wiring, build config, dependency pins, and
  the AI Gateway code (see below).

## File-by-file mapping

| This package | Upstream path |
| --- | --- |
| `src/create-emit-stream-event.ts` | `@ai-sdk/harness-codex/src/bridge/create-emit-stream-event.ts` |
| `src/codex-step-tracker.ts` | `@ai-sdk/harness-codex/src/bridge/codex-step-tracker.ts` |
| `src/turn-driver.ts` | `@ai-sdk/harness-codex/src/bridge/index.ts` |
| `src/main.ts` | — (new; upstream's entry is `bridge/index.ts` itself) |

The bridge runtime upstream keeps in `@ai-sdk/harness/src/bridge/` lives in
[`@amond-ai/harness-bridge-runtime`](../harness-bridge-runtime) instead. The wire
protocol it speaks lives in [`@amond-ai/harness-protocol`](../harness-protocol),
behind its `./codex` entry point. Each records its own vendoring; the patch
numbers below are the numbering this file shares with `harness-bridge-runtime`
and `harness-claude-code-bridge`, so a citation by number resolves across those
three. `harness-protocol` numbers its own patches separately — its list is
five entries long and unrelated to this one.

## Patches carried on top of upstream

1. `style(codex-host): apply the repository lint config` — formatting only.
2. `refactor(codex-host): inject the Codex constructor through createTurnDriver`
   — the module no longer boots itself. `createTurnDriver({ createCodex, workdir })`
   returns the `onStart`/`onStop` pair, so tests drive a fake `Codex` and
   `main.ts` is the one module that loads the real SDK. The thread id moves
   from module scope into that closure with it, which is what lets two drivers
   stand up in one process. Upstream's `as any` cast over the whole SDK module
   is replaced by the structural `CodexLike`/`CodexThreadLike` surfaces the
   driver actually calls, leaving one cast at the seam in `main.ts`.
3. `refactor(codex-host): drop host-defined tools and the CLI relay` — upstream
   works around a Codex bug that leaves MCP tools unregistered by standing up an
   HTTP relay on `127.0.0.1:0` and writing a shim script into the sandbox
   (`cli-relay.ts`, `tool-relay.ts`, `tool-relay-auth.ts`, and the
   `--cli-shim-dir` argument). The client never sends `start.tools`; a `start`
   that carries it is refused instead, the way the Claude bridge refuses it
   under the same number.
7. `feat(codex-host): add an interrupt command that ends the turn with a result`
   — the runtime's half is in `harness-bridge-runtime` under this number. The
   Codex SDK has no counterpart to the Claude query's `interrupt()`: its only
   lever is `runStreamed`'s `signal`, which is the same one `abort` pulls. So
   the adapter's half is the *ending*, not the stopping — the reason is
   remembered, the signal is aborted, and the turn is reported as a
   `finish { stopped: 'interrupted' }` carrying what it produced before the
   stop. A client `abort` aborts the same signal and gets no `finish`, which is
   the whole difference between the two commands. There is no escalation timer
   and no `interruptGraceMs`: the abort is the escalation.
8. `feat(codex-host): report stop reason and the journal on finish` —
   `finish.stopped`, `error.phase`, and `journalPath` flat on both, per
   `codexTurnHostFinishSchema` / `codexTurnHostErrorSchema`. Upstream's `finish`
   carries none of the three. Claude's half of this number reports its two
   session artifacts in an envelope; Codex's session is a thread id that already
   rides `bridge-thread`, so the journal — the runtime's own property — rides the
   frame flat instead. The runtime's half, `emitError` forwarding a
   `journalPath` verbatim the way it forwards `sessionArtifacts`, is in
   `harness-bridge-runtime` under the same number.
22. `feat(codex-host): echo the interrupt reason on the ending it caused` —
    `interruptedBy` on the `finish` an interrupt produced and on a run-phase
    `error` that landed during the wind-down, for the reason the Claude bridge
    carries it under this number: the client's own memory of the stop it asked
    for does not survive a step that never committed.
23. `fix(codex-host): end a failed turn once` — upstream reports `turn.failed`
    and a fatal stream `error` through `emitError` and then falls through to the
    `finish` below the loop, so a turn that failed is reported as having failed
    *and* then finished. `finish` and `error` are alternative endings; the first
    terminal error now latches and suppresses the `finish`.
24. `feat(codex-host): refuse a start this host cannot honour` — upstream
    ignores `permissionMode` and `builtinToolFiltering`, both of which the
    shared `start` base schema accepts. Codex has no allow/deny list over its
    built-in tools, and the thread runs `sandboxMode: 'danger-full-access'` —
    which is what `allow-all` names and what the two narrower modes do not. A
    turn that ran with more access than it asked for is worse than one that did
    not run, so a `permissionMode` other than `allow-all`, and any
    `builtinToolFiltering`, are refused in the `start` phase.
25. `feat(codex-host): refuse a mid-turn user message while the turn is running`
    — Codex takes one prompt per turn and upstream never reads the runtime's
    user-message queue. The client is not left with nothing: the runtime rejects
    every unanswered entry when it closes the queue. But that is at the *end* of
    the turn, which is the wait a message sent mid-turn exists to avoid. The
    queue is now drained as it fills, so the
    `user-message-response { accepted: false }` arrives while the turn is still
    running.
37. `fix(codex-host): emit one paired call for a web search without an id` —
    upstream's `7040da0` emits a `web_search` call from `item.started` /
    `item.updated` once the query is known, keyed by the item id. An item Codex
    sent without an id falls back to a fresh UUID per event, so that early call
    never matched its completion: the completion emitted a second call, and the
    first stayed without a result. Such a search now emits its call only at
    `item.completed`, with the result.
38. `fix(codex-host): pair the call and result of an id-less command or MCP call`
    — upstream emits a `command_execution` or `mcp_tool_call` call at
    `item.started` and its result at `item.completed`, both keyed by
    `item.id ?? randomUUID()`. Without an id, the two got different fresh
    UUIDs, leaving a call with no result and a result with no call. Such an
    item now emits its call at `item.completed`, from the completed item's
    `command` or `arguments`, with the result under the same id, as patch 37
    does for a search. "Without an id" means `null` as well as absent, the
    same test as the `??` fallback; patch 37's guard now uses it too. The
    Codex CLI (0.160.1) gives every item an `item_<n>`
    id and reuses it from start to completion, so this guards the optional
    wire shape the bridge reads rather than a case seen in practice.

## Upstream behaviour deliberately dropped

- **The `pnpm install` bootstrap inside the sandbox.** Upstream's
  `codex-bootstrap.ts` installs `src/bridge/package.json` into the sandbox at
  run time and resolves `@openai/codex-sdk` from there. This bridge is baked
  into the image the way the Claude one is: the bundle leaves the SDK external
  and the image pins it.
- **`codex-subscription.ts`.** Upstream reads `~/.codex/auth.json` or the OS
  keyring and refreshes the OAuth token itself. It imports `node:fs`, `node:os`,
  `node:crypto` and `node:child_process`, and this repository has no
  credential-brokering primitive to rebuild it on. Subscription credentials
  arrive the way every other credential does — through the consumer's
  `env: () => Record<string, string>` thunk, which is the environment this
  process forwards to the CLI child.
- **The AI Gateway branch.** `AI_GATEWAY_BASE_URL`, `AI_GATEWAY_API_KEY` and
  `AI_SDK_HARNESS_CLIENT_APP` select Vercel's own routing product, qualify the
  model id with an `openai/` prefix, and force
  `model_supports_reasoning_summaries`. Nothing in this deployment sets any of
  the three, and an env var named for another vendor's harness is worse than no
  branch at all. The generic custom-provider path it sat beside — `OPENAI_BASE_URL`
  or `start.headers` configuring `model_providers.agent_bridge_openai` — is kept
  unchanged.
