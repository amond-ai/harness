# @pleaseai/harness-protocol

The bridge wire protocol the turn host and its Worker client both speak — the frames that
cross the sandbox boundary, in one place so a change to the wire is one change.

Most of it is [vendored verbatim](./UPSTREAM.md) from Vercel's `@ai-sdk/harness` and
`@ai-sdk/harness-claude-code`: the outbound stream parts, the transport frames, the shared
inbound commands, and Claude's `start` payload. `src/protocol.ts` is the only part this
repository writes — the SDK options the Worker owns, the run's permission posture, and the
`interrupt` command — composed on the vendored `start` schema the way an upstream adapter
composes on the base.
