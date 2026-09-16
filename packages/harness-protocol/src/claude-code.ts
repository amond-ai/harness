/*
 * The Claude Code bridge's wire protocol, in one place — the `./claude-code` entry point.
 *
 * An entry of its own rather than the package root, so that the two adapters are symmetric: both
 * call their `start` payload `startMessageSchema`, and a consumer picking between them from one
 * namespace would be picking by luck. The load-bearing reason is that the root is on the critical
 * path of a bundle — `harness-claude-code-bridge` value-imports this package and does not mark it
 * external, so everything the root exports is inlined into `dist/bridge.mjs`. A zod schema is a
 * `const x = z.object(…)` call, which a bundler keeps unless it is annotated pure, so one entry
 * per adapter is what keeps each bridge carrying only its own adapter's schemas by construction.
 *
 * The `harness-v1/*` lines are duplicated from `index.ts` rather than gathered behind a
 * `harness-v1/index.ts`: that directory is a byte-identical vendored copy and UPSTREAM.md says so,
 * which a new file of ours inside it would muddy. `export * from './index'` is likewise not the
 * shortcut it looks like — the root carries no adapter today, but re-exporting it would put
 * whatever the root grows next into both adapter bundles, which is the coupling the split exists
 * to remove.
 */

export * from './bridge-extensions'
export * from './harness-v1/harness-v1-bridge-protocol'
export * from './harness-v1/harness-v1-call-warning'
export * from './harness-v1/harness-v1-diagnostic'
export * from './harness-v1/harness-v1-metadata'
export * from './harness-v1/harness-v1-response-format'
export * from './harness-v1/harness-v1-stream-part'
export * from './protocol'
