# Upstream

The bridge runtime is a fork of Vercel's shared harness bridge, vendored rather
than depended on: it must run inside the sandbox image against a pinned CLI, and
the patches below are not upstream yet.

- **Repository**: [vercel/ai](https://github.com/vercel/ai)
- **Commit**: `3d3afacf9b587f5df1edd6cfdb91b3771d1c7e4e`
- **Tag**: `@ai-sdk/harness-claude-code@1.0.90`
- **Packages taken from**: `@ai-sdk/harness@1.0.87`
- **License**: Apache-2.0

## File-by-file mapping

| This package | Upstream path |
| --- | --- |
| `src/bridge-runtime.ts` | `@ai-sdk/harness/src/bridge/index.ts` |
| `src/harness-bridge-capability-unsupported-error.ts` | `@ai-sdk/harness/src/bridge/harness-bridge-capability-unsupported-error.ts` |
| `src/index.ts` | — (new; the package surface) |

Both files arrived here from
[`@amond-ai/harness-claude-code-bridge`](../harness-claude-code-bridge), where
they were first vendored, when a second harness made the split worth paying for.
Upstream keeps the same split — this is `@ai-sdk/harness/bridge`, the runtime
every adapter's bridge imports, and the Claude package is
`@ai-sdk/harness-claude-code/bridge`, which is the adapter on top of it.

## Patches carried on top of upstream

**The numbers are the ones these patches carry in
[`harness-claude-code-bridge/UPSTREAM.md`](../harness-claude-code-bridge/UPSTREAM.md)
and [`harness-codex-bridge/UPSTREAM.md`](../harness-codex-bridge/UPSTREAM.md),
kept rather than renumbered.** They are cited by number in commit messages and in
a test comment, and a renumbering would silently repoint every one of those
citations at a different patch. The gaps are the patches that stayed with an
adapter; a number above 22 belongs to the Codex adapter, which arrived after the
Claude list stopped growing.

5. `feat(turn-host): journal frames to disk before sending them` — the disk
   append is awaited before the frame reaches the socket, unconditionally;
   upstream batches on `setImmediate` and never awaits. Delta frames
   (`{ journal: false }`) are live-only. The resume path obeys the same rule:
   `replay` is queued on the journal chain rather than writing to the socket
   synchronously.

7. `feat(turn-host): add an interrupt command that ends the turn with a result`
   (**the runtime's half**) — the `interrupt` inbound command, the
   `INTERRUPT_REASONS` list it validates an inbound reason against, and the
   `turn.onInterrupt` registration that hands the reason to the adapter. What
   the adapter then *does* with it — `query.interrupt()` instead of aborting, so
   the turn ends with a typed `result` — stayed with the Claude bridge under the
   same number.

8. `feat(turn-host): report stop reason and session artifacts on finish`
   (**the runtime's half**) — `emitError` forwards an optional `journalPath`
   verbatim, omitting the key when the caller names none, the way it forwards
   `sessionArtifacts` under patch 20. It exists for the second adapter:
   `harness-codex-bridge` reports the journal flat on `finish` and `error`
   rather than inside an envelope, because two of `sessionArtifacts`'s three
   fields name a session *file* and Codex's session is a thread id that rides
   `bridge-thread`. The value is always `turn.journalPath`; the runtime neither
   inspects it nor decides whether an adapter's schema carries it.

11. `fix(turn-host): deliver a frame to a socket at most once across resume` — a
    `resume` arriving while frames sit on the journal chain made `replay` and the
    chain each send them. `replay` now claims every `seq` up to the counter it
    snapshots by raising the delivered-seq mark before it yields, so the chain
    skips those frames and the replay delivers them itself, in order, after their
    appends. Upstream sends synchronously and cannot hit this.

12. `fix(turn-host): refuse a start while a turn is running` — upstream accepts a
    second `start` and lets both turns interleave frames on one stream; the
    runtime answers it with a `start`-phase error on the sending socket and
    leaves the running turn untouched. The `listening` handler only promotes
    `init` → `waiting` rather than assigning unconditionally: under bun it can
    run after a turn has already started, and the guard reads that state.

13. `chore(turn-host): apply AI code review suggestions` (**the runtime's half**)
    — the console capture decodes UTF-8 byte chunks through a per-stream
    `StringDecoder`, so a multi-byte character split across two writes no longer
    surfaces as U+FFFD in the `sandbox-log` frames (a chunk written under another
    explicit encoding is still decoded as declared); `close` removes the
    `uncaughtException` / `unhandledRejection` listeners and restores the
    original `stdout`/`stderr` writers, so a process that runs several bridges
    (the test suite) neither accumulates listeners nor routes a later bridge's
    output through a closed one; and the bun start-up branch promotes
    `init` → `waiting` itself, so a host connecting before the `listening`
    handler runs sees the bridge ready.

15. `fix(turn-host): require a bridge channel token` — upstream defaults the
    expected token to `''`, which authorizes a client sending an empty
    `agent_bridge_token` on a `0.0.0.0` listener. `runBridge` now rejects before
    it binds, so an unconfigured host has no open port rather than an open one.
    Reporting that rejection as `bridge-fatal` is the adapter's entry point's
    job and stayed in `harness-claude-code-bridge/src/main.ts`.

17. `fix(turn-host): exit after an uncaught crash and forward the permission
    mode the schema accepts` (**the runtime's half**) — the
    `uncaughtException` / `unhandledRejection` listeners still emit the `error`
    frame but then flush the journal and exit 1 (`onExit` when injected), instead
    of keeping a process alive whose state nobody can reason about; and the
    console capture forwards to and restores the writers it found at install time
    rather than the ones bound at start-up. The SDK permission-mode guard is the
    adapter's and stayed there.

18. `feat(turn-host): acknowledge a start before the query speaks` — the runtime
    emits a journaled `bridge-started` frame the moment it enters `running`, so a
    client can prove its `start` was taken without waiting for the query's first
    message, which a cold `query()` can delay past any sensible bound.

20. `feat(turn-host): report the session artifacts on a run-phase error too`
    (**the runtime's half**) — `emitError` forwards an optional
    `sessionArtifacts` verbatim and omits the key when the caller knows none. The
    runtime neither inspects nor builds it; which artifacts a turn has is the
    adapter's knowledge, and that half stayed with the Claude bridge.

22. `feat(turn-host): echo the interrupt reason on the ending it caused`
    (**the runtime's half**) — `emitError` forwards an optional `interruptedBy`
    the way it forwards `sessionArtifacts`, omitting the key when the caller
    names none. Deciding *when* an ending carries one is the adapter's.

Upstream behaviour deliberately dropped: `BRIDGE_REPLAY_FROM_DISK` as the gate on
disk-first journaling — it is unconditional here; the env var still selects
reload-on-start.
