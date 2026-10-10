# Upstream

The wire protocol is vendored from Vercel's harness packages rather than
depended on: `@ai-sdk/harness`'s `src/agent/*` layer pulls `ai@7` in behind it,
which has no business inside a sandbox image, and the turn host that runs there
needs the same schemas the Worker client does.

- **Repository**: [vercel/ai](https://github.com/vercel/ai)
- **Commit**: `eb77f09e3c06c28e860d92e0de941b143c2eecec`
- **Tag**: `@ai-sdk/harness-claude-code@1.0.142` (the same commit carries
  `@ai-sdk/harness@1.0.138`)
- **Packages taken from**: `@ai-sdk/harness-claude-code@1.0.142`,
  `@ai-sdk/harness@1.0.138` (re-vendored from `1.0.90` / `1.0.87`),
  `@ai-sdk/harness-codex@1.0.111`
- **License**: Apache-2.0 (all three packages)

`@ai-sdk/harness-codex@1.0.111` was taken from the published package rather than
from a commit. That is safe for the one file vendored from it: it imports four
schemas from `@ai-sdk/harness` and adds a `start` extension, and every one of
those four exists in the `1.0.138` copy under `harness-v1/`. The re-vendor
changed two of them only by addition — the outbound union gained the
`tool-input-*` parts, which the Codex bridge never emits, and the inbound
`tool-result` an optional `toolResult`.

## File-by-file mapping

| This package | Upstream path |
| --- | --- |
| `src/claude-code-bridge-protocol.ts` | `@ai-sdk/harness-claude-code/src/claude-code-bridge-protocol.ts` |
| `src/harness-v1/harness-v1-bridge-protocol.ts` | `@ai-sdk/harness/src/v1/harness-v1-bridge-protocol.ts` |
| `src/harness-v1/harness-v1-stream-part.ts` | `@ai-sdk/harness/src/v1/harness-v1-stream-part.ts` |
| `src/harness-v1/harness-v1-diagnostic.ts` | `@ai-sdk/harness/src/v1/harness-v1-diagnostic.ts` |
| `src/harness-v1/harness-v1-response-format.ts` | `@ai-sdk/harness/src/v1/harness-v1-response-format.ts` |
| `src/harness-v1/harness-v1-call-warning.ts` | `@ai-sdk/harness/src/v1/harness-v1-call-warning.ts` |
| `src/harness-v1/harness-v1-metadata.ts` | `@ai-sdk/harness/src/v1/harness-v1-metadata.ts` |
| `src/harness-v1/harness-v1-questions-tool.ts` | `@ai-sdk/harness/src/v1/harness-v1-questions-tool.ts` |
| `src/codex-bridge-protocol.ts` | `@ai-sdk/harness-codex/src/codex-bridge-protocol.ts` |
| `src/protocol.ts` | — (new; extends the vendored Claude `start` schema, see below) |
| `src/bridge-extensions.ts` | — (new; the agent-agnostic half of `protocol.ts`, see below) |
| `src/codex-protocol.ts` | — (new; extends the vendored Codex `start` schema, see below) |
| `src/index.ts` | — (new; the package root — the shared halves) |
| `src/claude-code.ts` | — (new; the `./claude-code` entry point) |
| `src/codex.ts` | — (new; the `./codex` entry point) |

The vendored files start as byte-identical copies, under the repository lint
config (patch 1), and the patches below are the only edits made to them since.
That closure imports only `zod/v4`, each other, and **types** from
`@ai-sdk/provider` and `@ai-sdk/provider-utils` (`harness-v1-questions-tool.ts`
types its tool as a `FunctionTool`); nothing reaches `ai@7`. The one edit made
on vendoring is each adapter file's `@ai-sdk/harness` import
(`claude-code-bridge-protocol.ts` and `codex-bridge-protocol.ts`), repointed at
`./harness-v1/harness-v1-bridge-protocol`.

`codex-bridge-protocol.ts` is deliberately not re-exported either, for the same
reason `claude-code-bridge-protocol.ts` is not: two `startMessageSchema`s under
one namespace would leave a consumer picking by luck. Claude's extension is the
`./claude-code` entry and Codex's is the `./codex` entry; the root carries
neither.

`@ai-sdk/provider` is therefore a devDependency at the version the root
catalog's `@ai-sdk/harness@1.0.87` pins (`4.0.8`), and `@ai-sdk/provider-utils`
one at the version that same release pins (`5.0.30`, through the root catalog,
which `harness-bridge-runtime`'s `ToolResultPart` import shares), so this
package shares one copy of each with the harness packages. The root catalog's
`@ai-sdk/harness` was not bumped with the re-vendor; the files vendored at
`1.0.138` type-check against both. The imports are type-only, so they are
erased at compile time and reach neither the turn host's bundle nor the sandbox
image.

What the `1.0.138` / `1.0.142` re-vendor brought in: the `tool-input-start`,
`tool-input-delta` and `tool-input-end` parts and their entries in both
unions, `stepToolCallCount` on `tool-call`, the inbound `tool-result`'s
structured `toolResult`, the questions-tool schema, and the `start` fields
`agentProgressSummaries`, `forwardSubagentText` and `resumeSessionId` — the
last an alias of this package's own `resume` that the turn host resolves. The
questions-tool file is a shared half, so the root and both adapter entries
export it.

## Patches carried on top of upstream

1. `style(harness-protocol): apply the repository lint config` — formatting
   only.
2. `refactor(harness-protocol): compose the turn host's start schema on the
   vendored protocol` — `src/protocol.ts` holds only what this deployment adds,
   composed the way upstream composes:
   `harnessV1BridgeStartBaseSchema` → the Claude fields → the SDK-option fields
   (`settingSources`, `persistSession`, `pathToClaudeCodeExecutable`,
   `maxBudgetUsd`, `sessionId`, `resume`, `emitDeltas`), the permission-mode
   widening to `harness enum | SDK enum`, the run's permission posture
   (`refuseTools`, `deferTools`, `approvedRequests`, `approvalPolicy`),
   `interruptGraceMs`, and the `interrupt` inbound command. The outbound union,
   `bridge-ready`, and the shared inbound commands are the vendored ones.

3. `feat(harness-protocol): echo the interrupt reason on the ending it caused` —
   the `interrupt` command's `reason` is now `interruptReasonSchema`, and both
   `turnHostFinishSchema` and `turnHostErrorSchema` carry it back as an optional
   `interruptedBy`. The client's memory of the stop it asked for is not durable
   (an uncommitted Workflow step loses it), so without the echo a re-entered
   round reads a `finish { stopped: 'interrupted' }` as an unnamed timeout and
   the host's escalation as a turn that merely failed (#388).

4. `refactor(harness-protocol): lift the harness-neutral half of the bridge
   extension` — `src/bridge-extensions.ts` holds the part of `protocol.ts` that
   does not know which agent runs inside the sandbox: `interruptReasonSchema`,
   `interruptInboundSchema`, `stoppedReasonSchema`, `bridgeErrorPhaseSchema` and
   `turnHostStartedSchema`. `turnHostStartedSchema` is what forced it —
   `bridge-started` is emitted by `@amond-ai/harness-bridge-runtime`, not by any
   adapter, so its schema no longer belonged in a file about Claude's `start`.
   `protocol.ts` re-exports all five, so no consumer's import changed.

5. `feat(harness-protocol): add the codex wire schema` — `src/codex-protocol.ts`
   composes on the vendored Codex `start` the way `protocol.ts` composes on
   Claude's: the `interrupt` inbound command, and `finish`/`error` carrying
   `stopped`, `phase`, `interruptedBy` and a flat optional `journalPath`. Three
   of Claude's fields are deliberately absent — `deferredToolUse` (the bridge
   runs Codex under `approvalPolicy: 'never'`, so a turn never parks on a
   decision), and `sessionArtifacts`'s `sessionId` / `sessionTranscriptPath`
   (Codex's resume coordinate is a thread id, and it already rides the vendored
   `bridge-thread` frame). `src/codex.ts` publishes the result as `./codex`
   rather than adding it to the root: the root is value-imported by a bridge that
   does not mark this package external, so one entry per adapter is what keeps
   each sandbox bundle carrying only its own schemas.

6. `refactor(harness-protocol): give claude an entry and reduce the root to the
   shared halves` — `src/claude-code.ts` publishes `protocol.ts` as
   `./claude-code`, and `src/index.ts` drops it for `bridge-extensions.ts`. The
   root had been carrying Claude's schemas because Claude's adapter was the only
   one when it was written, and patch 5 left that in place rather than bury a
   rename of 13 call sites inside the Codex change. Nothing leaked either way
   even then — neither `dist/bridge.mjs` contains a schema of the other
   adapter's, before or after — so what this buys is the shape: a third adapter
   now gets the same deal the first two have, instead of finding a root that
   means "the shared halves plus whichever adapter arrived first".
   `claude-code.ts` duplicates the six `harness-v1/*` lines the way `codex.ts`
   does, for the reason recorded there.

7. `feat(harness-protocol): acknowledge the end of a resume replay` —
   `harness-v1-bridge-protocol.ts` adds `capabilities.resumeAck` to
   `bridge-hello` and a `bridge-resumed { upTo }` control frame to the outbound
   union. A bridge that advertises the capability sends `bridge-resumed` after
   the replay a `resume` asked for: every journaled event at or below `upTo` the
   client had not seen is ahead of it, and every event emitted later follows
   it. The boundary is the event stream's alone: a control reply the bridge
   sends outside the journal chain is not ordered against it, and a live-only
   event emitted before the resume is not replayed at all. It is not journaled
   and carries no `seq`. Without it a client has no replay
   boundary and has to approximate one from the greeting's `lastSeq`, which
   also counts live-only frames a replay never sends. This is the one edit to a
   vendored `harness-v1/` file; it lives there because the frame is part of
   the shared bridge protocol, so the root and both adapter entries carry it.

One upstream field is deliberately not taken as-is: `claude-code-bridge-protocol.ts`
declares `thinking` without `.optional()`, so its schema refuses every `start`
that omits it. `src/protocol.ts` reuses `.shape.thinking` and makes it optional
rather than restating the union. Codex's vendored `start` needs no such patch —
every field it adds is already `.optional()`.
