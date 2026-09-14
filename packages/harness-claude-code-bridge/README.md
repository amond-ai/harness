# @amond-ai/harness-claude-code-bridge

The per-turn host that runs **inside the sandbox image**: it hosts the Claude Agent SDK's
`query()` and serves the orchestrator over a WebSocket, appending every frame to a
sequence-numbered journal on disk before it sends it.

This package ships one artifact — `dist/bridge.mjs`, a Node bundle. It is not a library: the
orchestrator never imports it, it *execs* it. The Worker-side half is
[`@amond-ai/harness-claude-code`](../harness-claude-code).

## Baking it into an image

The bundle leaves three dependencies external, so they resolve from the image's own
`node_modules` and the SDK the turn runs on is the one the image pins:

- `@anthropic-ai/claude-agent-sdk`
- `ws`
- `zod`

```dockerfile
RUN npm install --global @amond-ai/harness-claude-code-bridge@<version> \
 && cp "$(npm root -g)/@amond-ai/harness-claude-code-bridge/dist/bridge.mjs" /opt/turn-host/bridge.mjs
RUN npm install --prefix /opt/turn-host @anthropic-ai/claude-agent-sdk ws zod

# The image build's smoke test: loads the bundle and the real SDK, prints both versions, exits 0.
RUN node /opt/turn-host/bridge.mjs --version
```

`/opt/turn-host/bridge.mjs` is the path the `sdk` turn driver execs
(`TURN_HOST_BUNDLE`). `--version` is what fails the *build* — rather than a turn, mid-run in a
sandbox — when the bundle cannot resolve its runtime dependencies.

## How a turn reaches it

The host takes `--workdir` and `--bridge-state-dir`, binds the port it is told to, prints
`bridge-ready` with that port, and gates the socket on the per-turn token. From there the
orchestrator sends `start`, consumes frames for one bounded round, and reconnects with
`attach { since }` — the journal replays everything after that sequence, so a dropped socket
loses nothing. The wire schema for all of it is
[`@amond-ai/harness-protocol`](../harness-protocol).

The process **does not exit when a turn ends**: only `stop` and `destroy` end it.

## Upstream

A fork of Vercel's `@ai-sdk/harness-claude-code` bridge (Apache-2.0).

## License

Apache-2.0 — see [LICENSE](./LICENSE).
