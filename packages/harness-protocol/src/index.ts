/*
 * The halves of the bridge wire protocol both adapters share — the package root.
 *
 * `harness-v1/` is vendored verbatim from `@ai-sdk/harness` (see UPSTREAM.md) and
 * `bridge-extensions.ts` is this deployment's agent-agnostic extension of it: the `interrupt`
 * command, the ending's `stopped` / `phase` vocabulary, and the `bridge-started` frame
 * `@amond-ai/harness-bridge-runtime` emits itself. Nothing here knows which agent runs inside the
 * sandbox, which is the membership rule for the root as much as for that file.
 *
 * Each adapter's `start` payload lives behind an entry point of its own — `./claude-code` and
 * `./codex`. Both call it `startMessageSchema`, so one namespace would leave a consumer picking by
 * luck; and the root is on the critical path of a bundle, since each bridge value-imports this
 * package without marking it external and so inlines whatever the root exports into the
 * `dist/bridge.mjs` that ships in its sandbox image. Keeping the adapters out of the root is what
 * leaves each of those bundles carrying only its own schemas by construction.
 */

export * from './bridge-extensions'
export * from './harness-v1/harness-v1-bridge-protocol'
export * from './harness-v1/harness-v1-call-warning'
export * from './harness-v1/harness-v1-diagnostic'
export * from './harness-v1/harness-v1-metadata'
export * from './harness-v1/harness-v1-response-format'
export * from './harness-v1/harness-v1-stream-part'
