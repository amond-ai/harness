# Upstream

The turn host is a fork of Vercel's Claude Code bridge, vendored rather than
depended on: it must run inside the sandbox image against a pinned CLI, and the
patches below are not upstream yet.

- **Repository**: [vercel/ai](https://github.com/vercel/ai)
- **Commit**: `3d3afacf9b587f5df1edd6cfdb91b3771d1c7e4e`
- **Tag**: `@ai-sdk/harness-claude-code@1.0.90`
- **Packages taken from**: `@ai-sdk/harness-claude-code@1.0.90`,
  `@ai-sdk/harness@1.0.87`
- **License**: Apache-2.0 (both packages)

## File-by-file mapping

| This repository | Upstream path |
| --- | --- |
| `src/turn-driver.ts` | `@ai-sdk/harness-claude-code/src/bridge/index.ts` |
| `src/create-emit-stream-event.ts` | `@ai-sdk/harness-claude-code/src/bridge/create-emit-stream-event.ts` |
| `src/compaction-latch.ts` | `@ai-sdk/harness-claude-code/src/bridge/compaction-latch.ts` |
| `src/tool-filtering.ts` | `@ai-sdk/harness-claude-code/src/bridge/tool-filtering.ts` |
| `src/claude-skills-option.ts` | `@ai-sdk/harness-claude-code/src/bridge/claude-skills-option.ts` |
| `src/claude-code-system-prompt.ts` | `@ai-sdk/harness-claude-code/src/bridge/claude-code-system-prompt.ts` |
| `src/main.ts` | — (new; upstream's entry is `bridge/index.ts` itself) |
| `src/permission-policy.ts` | — (new; the run's permission posture as a `PreToolUse` hook plus a `canUseTool` fallback, and the matcher that replays a human's approval) |
| `src/session-artifacts.ts` | — (new; the paths of a turn's two durable artifacts — the CLI's session jsonl and the journal — including the CLI's project-directory encoding) |

The bridge runtime upstream keeps in `@ai-sdk/harness/src/bridge/` lives in
[`@amond-ai/harness-bridge-runtime`](../harness-bridge-runtime) instead, because a
second harness's bridge needs the same transport. Its own `UPSTREAM.md` records
what was vendored there and carries the patches that went with it — **numbered as
they are here**, so a citation by number still resolves. The gaps in the list
below are those patches.

The wire protocol upstream keeps in `@ai-sdk/harness` and
`claude-code-bridge-protocol.ts` lives in
[`@amond-ai/harness-protocol`](../harness-protocol) instead, because phase 2's
Worker client needs the same schemas. Its own `UPSTREAM.md` records what was
vendored there.

## Patches carried on top of upstream

Each is a separate commit in this repository and is intended to go upstream.

1. `style(turn-host): apply the repository lint config` — formatting only.
2. `refactor(turn-host): inject query() through createTurnDriver` — the module
   no longer boots itself; `createTurnDriver({ query, workdir })` returns the
   `onStart` so tests can drive a fake `query()`.
3. `refactor(turn-host): drop host-defined tools and the MCP tool server` — the
   Worker never sends `start.tools`; the `@modelcontextprotocol/sdk` path and
   `json-schema-to-zod.ts` are gone and a `start` carrying `tools` is refused.
   The `mcp__harness-tools__` special-casing in `create-emit-stream-event.ts`
   went with it: nothing registers that server any more, so the branch and the
   `mcpToolUseIds` set it fed were unreachable.
4. `feat(turn-host): emit every SDK message as a raw frame` — every SDK message
   except `stream_event` rides the wire verbatim as `{ type: 'raw', rawValue }`
   ahead of the harness parts derived from it.
6. `feat(turn-host): accept the SDK options on start` — `settingSources`, the
   SDK `permissionMode` enum, `persistSession`, `pathToClaudeCodeExecutable`,
   `maxBudgetUsd`, `sessionId`, `resume`, `emitDeltas`, `refuseTools`,
   `deferTools`, `approvedRequests`, `approvalPolicy`, `interruptGraceMs`.
7. `feat(turn-host): add an interrupt command that ends the turn with a result`
   — `query.interrupt()` instead of aborting, so the turn ends with a typed
   `result`. The `AbortController` stays as the escalation. The `interrupt`
   command itself and the `turn.onInterrupt` seam that delivers its reason are
   the runtime's half, in `harness-bridge-runtime` under the same number.
8. `feat(turn-host): report stop reason and session artifacts on finish` —
   `finish.stopped`, `finish.sessionArtifacts`, `error.phase`.
9. `feat(turn-host): enforce the run's permission posture in the host` —
   `canUseTool` never pends under `approvalPolicy: 'deny'`, and a `PreToolUse`
   hook evaluates `approvedRequests` → `refuseTools` → `deferTools`.
10. `feat(turn-host): fail a routed turn whose command did not load` — a
    routed prompt whose command is missing from `system`/`init`'s
    `slash_commands` fails the turn before a token is spent.
14. `fix(turn-host): keep a subagent's recoverable error off the parent turn` —
    the terminal-error latch in `create-emit-stream-event.ts` ran above the
    `parent_tool_use_id` guard, so a Task subagent's `rate_limit`/`overloaded`
    ended the parent turn on an `error` with no `finish` once the parent's own
    `result` was empty (a `structured_output` answer). The latch moved below the
    guard.
16. `fix(turn-host): do not report an abort as a turn failure` — the catch around
    the SDK loop emitted `claude-code turn failed` for a host-initiated abort,
    which is a teardown the Worker asked for and not a failure. Every
    `abortCtl.abort()` in the file already emits its own explanation where there
    is one, so an aborted signal suppresses the generic error.

17. `fix(turn-host): exit after an uncaught crash and forward the permission
    mode the schema accepts` — the SDK permission-mode guard reads
    `sdkPermissionModeSchema` instead of a hand-copied list, so `auto` reaches
    the SDK as `auto` rather than falling through to the harness branch as
    `default`. The crash exit and the console-capture writer handling are the
    runtime's half, in `harness-bridge-runtime` under the same number.

19. `feat(turn-host): report the session id on finish` — `sessionArtifacts`
    carried the session *file*'s path but not the id the turn ran as, so a
    client that wanted to resume had to parse `<sessionId>.jsonl` out of the
    path — putting a CLI naming convention on the Worker's side of the split
    that field exists to keep on the host's. The id now rides beside the path
    (`sessionArtifactsSchema.sessionId` in `@amond-ai/harness-protocol`).

20. `feat(turn-host): report the session artifacts on a run-phase error too` —
    only `finish` named them, so the ordinary way a turn fails — the SDK
    throwing, a terminal error frame, an interrupt the query never answered —
    left the client with no session to resume, which is exactly the ending a
    retry follows. The three run-phase `error` emits now carry the same
    `sessionArtifacts` `finish` does (`turnHostErrorSchema.sessionArtifacts` in
    `@amond-ai/harness-protocol`), built by one `sessionArtifacts()` helper
    that also feeds `finish`. The `sessionId`/`sessionCwd` declarations moved above the
    interrupt handler, which is installed before the message loop that fills
    them.

21. `feat(turn-host): answer a denied request and name the deferred one` — layer 3
    of the ADR's D6 had no way to say *no* and no way to say *what* a deferral
    is waiting on. Two additions, one at each end of the wire. `start` gains
    `deniedRequests` (`deniedRequestSchema` in `@amond-ai/harness-protocol`),
    which the `PreToolUse` evaluator consumes one-shot **ahead of**
    `approvedRequests` and the defer rule: without it a human's refusal replays
    into the same `deferTools` pattern that deferred the call and defers
    forever, so the agent never hears the answer. A call on both lists is a
    contradiction the Worker should never send; it is denied, and the
    contradicting approval is consumed with the denial so an identical retry
    cannot be allowed by the entry the denial skipped. And `finish` gains
    `deferredToolUse` (`turnHostFinishSchema`), read off the SDK `result`'s
    `deferred_tool_use` beside the `terminal_reason` that already decided
    `stopped: 'deferred'` — `stopped` says a decision is owed, this says which
    request it is owed about, and an answer authorizes one request rather than
    the tool.

Upstream behaviour deliberately dropped: the `pnpm install` bootstrap inside the
sandbox (the image ships the dependencies).

22. `feat(turn-host): echo the interrupt reason on the ending it caused` — the
    host answered an `interrupt` with a `finish { stopped: 'interrupted' }`, or
    with a run-phase `error` when it escalated, and neither said *which* stop it
    was answering. The Worker's own memory of the reason it sent is not durable
    — a Workflow step that never commits loses it — so a re-entered round read
    the first as an unnamed timeout and the second as a turn that failed on its
    own, and a budget stop that lost its cause started another attempt with a
    fresh budget (#388, the #358 shape). The reason the `turn.onInterrupt`
    handler receives is now remembered and echoed as `interruptedBy`
    (`turnHostFinishSchema` / `turnHostErrorSchema` in
    `@amond-ai/harness-protocol`): on `finish` only beside
    `stopped: 'interrupted'`, so an SDK abort nobody asked for still names none;
    on the escalation `error` and on a query failure during the wind-down.
