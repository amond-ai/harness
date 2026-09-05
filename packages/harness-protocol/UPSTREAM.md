# Upstream

The wire protocol is vendored from Vercel's harness packages rather than
depended on: `@ai-sdk/harness`'s `src/agent/*` layer pulls `ai@7` in behind it,
which has no business inside a sandbox image, and the turn host that runs there
needs the same schemas the Worker client does.

- **Repository**: [vercel/ai](https://github.com/vercel/ai)
- **Commit**: `3d3afacf9b587f5df1edd6cfdb91b3771d1c7e4e`
- **Tag**: `@ai-sdk/harness-claude-code@1.0.90`
- **Packages taken from**: `@ai-sdk/harness-claude-code@1.0.90`,
  `@ai-sdk/harness@1.0.87`
- **License**: Apache-2.0 (both packages)

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
| `src/protocol.ts` | — (new; extends the vendored `start` schema, see below) |
| `src/index.ts` | — (new; the package surface) |

The vendored files are byte-identical copies. That closure imports only
`zod/v4`, each other, and **types** from `@ai-sdk/provider`; nothing reaches
`ai@7`. The single edit is `claude-code-bridge-protocol.ts`'s `@ai-sdk/harness`
import, repointed at `./harness-v1/harness-v1-bridge-protocol`.

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

One upstream field is deliberately not taken as-is: `claude-code-bridge-protocol.ts`
declares `thinking` without `.optional()`, so its schema refuses every `start`
that omits it. `src/protocol.ts` reuses `.shape.thinking` and makes it optional
rather than restating the union.
