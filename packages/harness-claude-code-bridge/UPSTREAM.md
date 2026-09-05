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
| `src/json-schema-to-zod.ts` | `@ai-sdk/harness-claude-code/src/bridge/json-schema-to-zod.ts` |
| `src/bridge-runtime.ts` | `@ai-sdk/harness/src/bridge/index.ts` |
| `src/harness-bridge-capability-unsupported-error.ts` | `@ai-sdk/harness/src/bridge/harness-bridge-capability-unsupported-error.ts` |
| `src/main.ts` | — (new; upstream's entry is `bridge/index.ts` itself) |

The wire protocol upstream keeps in `@ai-sdk/harness` and
`claude-code-bridge-protocol.ts` lives in
[`@pleaseai/harness-protocol`](../harness-protocol) instead, because phase 2's
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
5. `feat(turn-host): journal frames to disk before sending them` — the disk
   append is awaited before the frame reaches the socket, unconditionally;
   upstream batches on `setImmediate` and never awaits. Delta frames are
   live-only. The resume path obeys the same rule: `replay` is queued on the
   journal chain rather than writing to the socket synchronously.
6. `feat(turn-host): accept the SDK options on start` — `settingSources`, the
   SDK `permissionMode` enum, `persistSession`, `pathToClaudeCodeExecutable`,
   `maxBudgetUsd`, `sessionId`, `resume`, `emitDeltas`, `refuseTools`,
   `deferTools`, `approvedRequests`, `approvalPolicy`, `interruptGraceMs`.
7. `feat(turn-host): add an interrupt command that ends the turn with a result`
   — `query.interrupt()` instead of aborting, so the turn ends with a typed
   `result`. The `AbortController` stays as the escalation.
8. `feat(turn-host): report stop reason and session artifacts on finish` —
   `finish.stopped`, `finish.sessionArtifacts`, `error.phase`.
9. `feat(turn-host): enforce the run's permission posture in the host` —
   `canUseTool` never pends under `approvalPolicy: 'deny'`, and a `PreToolUse`
   hook evaluates `approvedRequests` → `refuseTools` → `deferTools`.
10. `feat(turn-host): fail a routed turn whose command did not load` — a
    routed prompt whose command is missing from `system`/`init`'s
    `slash_commands` fails the turn before a token is spent.
11. `fix(turn-host): deliver a frame to a socket at most once across resume` —
    a `resume` arriving while frames sit on the journal chain made `replay` and
    the chain each send them. `replay` now claims every `seq` up to the counter
    it snapshots by raising the delivered-seq mark before it yields, so the
    chain skips those frames and the replay delivers them itself, in order,
    after their appends. Upstream sends synchronously and cannot hit this.
12. `fix(turn-host): refuse a start while a turn is running` — upstream accepts
    a second `start` and lets both turns interleave frames on one stream; the
    bridge answers it with a `start`-phase error on the sending socket and
    leaves the running turn untouched. The `listening` handler now only
    promotes `init` → `waiting` rather than assigning unconditionally: under
    bun it can run after a turn has already started, and the guard reads that
    state.
13. `chore(turn-host): apply AI code review suggestions` — the console capture
    decodes UTF-8 byte chunks through a per-stream `StringDecoder`, so a
    multi-byte character split across two writes no longer surfaces as U+FFFD
    in the `sandbox-log` frames (a chunk written under another explicit
    encoding is still decoded as declared); `close` removes the
    `uncaughtException` / `unhandledRejection` listeners and restores the
    original `stdout`/`stderr` writers, so a process that runs several bridges
    (the test suite) neither accumulates listeners nor routes a later bridge's
    output through a closed one; and the bun start-up branch promotes
    `init` → `waiting` itself, so a host connecting before the `listening`
    handler runs sees the bridge ready.
14. `fix(turn-host): keep a subagent's recoverable error off the parent turn` —
    the terminal-error latch in `create-emit-stream-event.ts` ran above the
    `parent_tool_use_id` guard, so a Task subagent's `rate_limit`/`overloaded`
    ended the parent turn on an `error` with no `finish` once the parent's own
    `result` was empty (a `structured_output` answer). The latch moved below the
    guard.
15. `fix(turn-host): require a bridge channel token` — upstream defaults the
    expected token to `''`, which authorizes a client sending an empty
    `agent_bridge_token` on a `0.0.0.0` listener. `runBridge` now rejects before
    it binds, and `main.ts` reports that as `bridge-fatal`.
16. `fix(turn-host): do not report an abort as a turn failure` — the catch around
    the SDK loop emitted `claude-code turn failed` for a host-initiated abort,
    which is a teardown the Worker asked for and not a failure. Every
    `abortCtl.abort()` in the file already emits its own explanation where there
    is one, so an aborted signal suppresses the generic error.

17. `fix(turn-host): exit after an uncaught crash and forward the permission
    mode the schema accepts` — the `uncaughtException` / `unhandledRejection`
    listeners still emit the `error` frame but then flush the journal and exit
    1 (`onExit` when injected), instead of keeping a process alive whose state
    nobody can reason about; the console capture forwards to and restores the
    writers it found at install time rather than the ones bound at start-up;
    and the SDK permission-mode guard reads `sdkPermissionModeSchema` instead
    of a hand-copied list, so `auto` reaches the SDK as `auto` rather than
    falling through to the harness branch as `default`.

18. `feat(turn-host): acknowledge a start before the query speaks` — the bridge
    emits a journaled `bridge-started` frame the moment it enters `running`, so
    a client can prove its `start` was taken without waiting for the query's
    first message, which a cold `query()` can delay past any sensible bound.

Upstream behaviour deliberately dropped: the `pnpm install` bootstrap inside the
sandbox (the image ships the dependencies) and `BRIDGE_REPLAY_FROM_DISK` as the
gate on disk-first journaling (it is unconditional here; the env var still
selects reload-on-start).
