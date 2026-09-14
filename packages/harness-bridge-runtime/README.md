# @amond-ai/harness-bridge-runtime

The transport every per-turn bridge process shares. It binds the WebSocket
server, gates it on a per-turn token, stamps every frame with a monotonic `seq`,
appends each to a journal on disk *before* it reaches the socket, replays the
tail a reconnecting client has not seen, and services `abort`, `interrupt`,
`stop` and `destroy`. What it does not know is which agent runs inside the
sandbox — that is the adapter's, and it arrives as one callback.

```ts
import { runBridge } from '@amond-ai/harness-bridge-runtime'

await runBridge<StartMessage>({
  bridgeType: 'codex',
  bridgeStateDir,
  onStart: async (start, turn) => {
    turn.onInterrupt(reason => stopTheAgent(reason))
    for await (const event of runTheAgent(start, { signal: turn.abortSignal })) {
      turn.emit(translate(event))
    }
    turn.emit({ type: 'finish', finishReason: { unified: 'stop', raw: 'stop' } })
  },
  onStop: () => ({ threadId }),
})
```

`runBridge` resolves once the server is listening and has printed
`{"type":"bridge-ready","port":…}` on stdout, which is the line the orchestrator
waits for before it dials. The process then stays alive on the server until a
`stop` or `destroy` exits it.

## What the adapter provides, and what it gets

| Adapter provides | Why the runtime cannot decide it |
| --- | --- |
| `bridgeType` | Written into `bridge-meta.json`, so a relaunched orchestrator can tell which bridge it found. |
| `onStart(start, turn)` | Running one turn of one agent *is* the adapter. |
| `onStop()` | The resume coordinate a future process picks the session up by — a Codex thread id, a Claude session id — is the adapter's vocabulary. |
| `onDestroy()` | Whatever the adapter has to tear down. |

In return, `turn` carries `emit` (journaled by default, `{ journal: false }` for
liveness-only frames such as token deltas), `requestToolResult` and
`requestToolApproval` (the runtime matches the client's answer to the id the
adapter emitted), `experimental_userMessages`, `abortSignal`, `onInterrupt`,
`flush`, `bridgeLog`, `emitWarning`, `emitError` and `journalPath`.

## Node, deliberately

This package and `harness-claude-code-bridge` are the two members of this
repository that run *inside* the sandbox image, on Node, and they are exempt
from the runtime-neutrality assertion in `harness-claude-code`'s
`closure.test.ts` for that reason. There is no portable answer here: the
journal is a file, the server is a real socket, and the console capture replaces
`process.stdout.write`.

It carries no `zod` and no `@amond-ai/harness-protocol` dependency. An inbound
frame is a cast, not a parse — the wire schema belongs to the adapter that
defines the `start` payload, and keeping it out of here is what keeps the
schemas of one adapter off another adapter's bundle.

## Upstream

Vendored from Vercel's `@ai-sdk/harness`, Apache-2.0. See
[UPSTREAM.md](./UPSTREAM.md) for the exact commit and the patches carried on top.
