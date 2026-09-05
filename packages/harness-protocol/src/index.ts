/*
 * The bridge wire protocol, in one place.
 *
 * `harness-v1/` and `claude-code-bridge-protocol.ts` are vendored verbatim from
 * `@ai-sdk/harness` / `@ai-sdk/harness-claude-code` (see UPSTREAM.md);
 * `protocol.ts` is this deployment's extension of them. Both the turn host that
 * runs inside the sandbox and the Worker client that drives it import from
 * here, so a change to the wire is one change.
 *
 * `claude-code-bridge-protocol.ts` is deliberately not re-exported: its
 * `startMessageSchema` is the one `protocol.ts` extends, and exporting both
 * under the same name would leave a consumer picking the wrong one.
 */

export * from './harness-v1/harness-v1-bridge-protocol'
export * from './harness-v1/harness-v1-call-warning'
export * from './harness-v1/harness-v1-diagnostic'
export * from './harness-v1/harness-v1-metadata'
export * from './harness-v1/harness-v1-response-format'
export * from './harness-v1/harness-v1-stream-part'
export * from './protocol'
