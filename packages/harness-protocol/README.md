# @amond-ai/harness-protocol

The bridge wire protocol a turn host and its client both speak — the frames that cross the
sandbox boundary, in one place so a change to the wire is one change. It covers two adapters,
and it has one entry point per adapter.

| Entry | Carries |
| --- | --- |
| `@amond-ai/harness-protocol` | The shared `harness-v1` protocol, the agent-agnostic bridge extension, and **Claude's** `start` / `finish` / `error` / outbound union. |
| `@amond-ai/harness-protocol/codex` | The same shared halves, and **Codex's**. |

Two entries rather than more names on one, because both adapters call their payload
`startMessageSchema` and a consumer picking between them from a single namespace would be
picking by luck. The load-bearing reason is narrower: `harness-claude-code-bridge`
value-imports the root and does not mark this package external, so whatever the root exports is
inlined into the bundle that ships in the sandbox image. A zod schema is a `z.object(…)` call a
bundler keeps, so one entry per adapter is what keeps each bundle to its own schemas by
construction rather than by hoping a tree-shaker cooperates.

Most of it is [vendored verbatim](./UPSTREAM.md) from Vercel's `@ai-sdk/harness`,
`@ai-sdk/harness-claude-code` and `@ai-sdk/harness-codex`: the outbound stream parts, the
transport frames, the shared inbound commands, and each adapter's `start` payload. Four files
are this repository's own:

- `src/bridge-extensions.ts` — the half that does not know which agent runs inside the sandbox:
  the `interrupt` command, the ending's `stopped` / `phase` vocabulary, and the `bridge-started`
  frame `@amond-ai/harness-bridge-runtime` emits itself. A field belongs here only if a bridge
  with no Claude and no Codex behind it would still send or accept it.
- `src/protocol.ts` — Claude's: the SDK options the client owns, the run's permission posture,
  and the session artifacts a later attempt resumes by. Re-exports `bridge-extensions.ts`, so
  every existing import from the package root still resolves.
- `src/codex-protocol.ts` — Codex's: `finish` and `error` carrying `stopped`, `phase`,
  `interruptedBy` and a flat optional `journalPath`. No `deferredToolUse` (Codex runs under a
  never-ask approval policy, so a turn never parks on a decision) and no `sessionArtifacts`
  envelope (its resume coordinate is a thread id, and that already rides the vendored
  `bridge-thread` frame).
- `src/codex.ts` — the `./codex` entry point.

Each adapter extension exists for one measured reason: the vendored stream-part schemas are
plain `z.object`s, and a plain `z.object` **strips** keys it does not declare. A client that
validated a host's `finish` against the upstream union would parse it successfully and receive
it with `stopped` deleted — and because a host hardcodes `finishReason` to `stop` on every
ending, that frame is then indistinguishable from a completed turn. Both
`protocol.test.ts` and `codex-protocol.test.ts` assert exactly that deletion.
