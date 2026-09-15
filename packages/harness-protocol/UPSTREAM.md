# Upstream

The wire protocol is vendored from Vercel's harness packages rather than
depended on: `@ai-sdk/harness`'s `src/agent/*` layer pulls `ai@7` in behind it,
which has no business inside a sandbox image, and the turn host that runs there
needs the same schemas the Worker client does.

- **Repository**: [vercel/ai](https://github.com/vercel/ai)
- **Commit**: `3d3afacf9b587f5df1edd6cfdb91b3771d1c7e4e`
  (`@ai-sdk/harness-claude-code@1.0.90`, `@ai-sdk/harness@1.0.87`)
- **Packages taken from**: `@ai-sdk/harness-claude-code@1.0.90`,
  `@ai-sdk/harness@1.0.87`, `@ai-sdk/harness-codex@1.0.111`
- **License**: Apache-2.0 (all three packages)

`@ai-sdk/harness-codex@1.0.111` is a later release than the other two and was
taken from the published package rather than from that commit. That is safe for
the one file vendored from it: it imports four schemas from `@ai-sdk/harness` and
adds a `start` extension, and every one of those four exists unchanged in the
`1.0.87` copy under `harness-v1/`.

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
| `src/codex-bridge-protocol.ts` | `@ai-sdk/harness-codex/src/codex-bridge-protocol.ts` |
| `src/protocol.ts` | — (new; extends the vendored Claude `start` schema, see below) |
| `src/bridge-extensions.ts` | — (new; the agent-agnostic half of `protocol.ts`, see below) |
| `src/codex-protocol.ts` | — (new; extends the vendored Codex `start` schema, see below) |
| `src/index.ts` | — (new; the package surface) |
| `src/codex.ts` | — (new; the `./codex` entry point) |

The vendored files are byte-identical copies. That closure imports only
`zod/v4`, each other, and **types** from `@ai-sdk/provider`; nothing reaches
`ai@7`. The single edit is each adapter file's `@ai-sdk/harness` import
(`claude-code-bridge-protocol.ts` and `codex-bridge-protocol.ts`), repointed at
`./harness-v1/harness-v1-bridge-protocol`.

`codex-bridge-protocol.ts` is deliberately not re-exported either, for the same
reason `claude-code-bridge-protocol.ts` is not: two `startMessageSchema`s under
one namespace would leave a consumer picking by luck. Claude's extension is the
package root and Codex's is the `./codex` entry.

`@ai-sdk/provider` is therefore a devDependency at the version
`@ai-sdk/harness@1.0.87` pins: the imports are type-only, so it is erased at
compile time and reaches neither the turn host's bundle nor the sandbox image.

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

One upstream field is deliberately not taken as-is: `claude-code-bridge-protocol.ts`
declares `thinking` without `.optional()`, so its schema refuses every `start`
that omits it. `src/protocol.ts` reuses `.shape.thinking` and makes it optional
rather than restating the union. Codex's vendored `start` needs no such patch —
every field it adds is already `.optional()`.
