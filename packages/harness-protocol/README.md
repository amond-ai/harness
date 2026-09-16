# @amond-ai/harness-protocol

The bridge wire protocol a turn host and its client both speak — the frames that cross the
sandbox boundary, in one place so a change to the wire is one change. It covers two adapters,
and it has one entry point per adapter plus a root carrying what they share.

| Entry | Carries |
| --- | --- |
| `@amond-ai/harness-protocol` | The shared `harness-v1` protocol and the agent-agnostic bridge extension — the half that does not know which agent runs inside the sandbox. |
| `@amond-ai/harness-protocol/claude-code` | The shared halves, and **Claude's** `start` / `finish` / `error` / outbound union. |
| `@amond-ai/harness-protocol/codex` | The shared halves, and **Codex's**. |

An entry per adapter rather than more names on one, because both adapters call their payload
`startMessageSchema` and a consumer picking between them from a single namespace would be
picking by luck. The load-bearing reason is narrower: each bridge value-imports this package
and does not mark it external, so whatever the entry it reaches for exports is inlined into the
bundle that ships in the sandbox image. A zod schema is a `z.object(…)` call a bundler keeps,
so one entry per adapter is what keeps each bundle to its own schemas by construction rather
than by hoping a tree-shaker cooperates. Keeping the root to the shared half is what extends
that to a third adapter: it gets an entry of its own, rather than finding the root already
spoken for by whichever adapter was written first.

Most of it is [vendored verbatim](./UPSTREAM.md) from Vercel's `@ai-sdk/harness`,
`@ai-sdk/harness-claude-code` and `@ai-sdk/harness-codex`: the outbound stream parts, the
transport frames, the shared inbound commands, and each adapter's `start` payload. Six files
are this repository's own:

- `src/bridge-extensions.ts` — the half that does not know which agent runs inside the sandbox:
  the `interrupt` command, the ending's `stopped` / `phase` vocabulary, and the `bridge-started`
  frame `@amond-ai/harness-bridge-runtime` emits itself. A field belongs here only if a bridge
  with no Claude and no Codex behind it would still send or accept it.
- `src/protocol.ts` — Claude's: the SDK options the client owns, the run's permission posture,
  and the session artifacts a later attempt resumes by.
- `src/codex-protocol.ts` — Codex's: `finish` carrying `stopped`, `error` carrying `phase`, and
  both carrying `interruptedBy` and a flat optional `journalPath`. No `deferredToolUse` (Codex
  runs under a never-ask approval policy, so a turn never parks on a decision) and no
  `sessionArtifacts` envelope (its resume coordinate is a thread id, and that already rides the
  vendored `bridge-thread` frame).
- `src/index.ts` — the package root entry point: `harness-v1/` and `bridge-extensions.ts`.
- `src/claude-code.ts` — the `./claude-code` entry point: those and `protocol.ts`.
- `src/codex.ts` — the `./codex` entry point: those and `codex-protocol.ts`.

Each adapter extension exists for one measured reason: the vendored stream-part schemas are
plain `z.object`s, and a plain `z.object` **strips** keys it does not declare. A client that
validated a host's `finish` against the upstream union would parse it successfully and receive
it with `stopped` deleted — and because a host hardcodes `finishReason` to `stop` on every
ending, that frame is then indistinguishable from a completed turn. Both
`protocol.test.ts` and `codex-protocol.test.ts` assert exactly that deletion.
