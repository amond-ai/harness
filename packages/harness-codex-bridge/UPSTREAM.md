# Upstream

The turn host is a fork of Vercel's Codex bridge, vendored rather than depended
on: it must run inside the sandbox image against a pinned SDK, and the patches
below are not upstream yet.

- **Repository**: [vercel/ai](https://github.com/vercel/ai)
- **Packages taken from**: `@ai-sdk/harness-codex@1.0.113`, `@ai-sdk/harness@1.0.87`
- **License**: Apache-2.0 (both packages)

`@ai-sdk/harness-codex@1.0.113` is a later release than the `@ai-sdk/harness@1.0.87`
the rest of this repository vendors, and it was taken from the published package
rather than from a commit. The sibling packages record the same split for the same
reason: the Codex half of upstream moves on its own, and the `1.0.87` copy under
`harness-protocol/src/harness-v1/` is what both adapters compose on.
`harness-protocol` pins `codex-bridge-protocol.ts` at `1.0.111`; that file is
byte-identical in `1.0.113`, so the `start` this host parses is the one it
vendored.

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
