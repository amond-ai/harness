/*
 * The Codex bridge's wire protocol, in one place — the `./codex` entry point.
 *
 * An entry of its own rather than more names on the root, because both adapters' `start` schemas
 * are called `startMessageSchema` and a consumer picking between them from one namespace would be
 * picking by luck. The collision is the visible reason; the load-bearing one is that the root is on
 * the critical path of a bundle — each bridge value-imports it and does not mark this package
 * external, so the root's schemas are inlined into `dist/bridge.mjs`. A zod schema is
 * a `const x = z.object(…)` call, which a bundler keeps unless it is annotated pure, so one entry
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
export * from './codex-protocol'
export * from './harness-v1/harness-v1-bridge-protocol'
export * from './harness-v1/harness-v1-call-warning'
export * from './harness-v1/harness-v1-diagnostic'
export * from './harness-v1/harness-v1-metadata'
export * from './harness-v1/harness-v1-questions-tool'
export * from './harness-v1/harness-v1-response-format'
export * from './harness-v1/harness-v1-stream-part'
