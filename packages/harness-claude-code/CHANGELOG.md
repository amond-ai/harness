# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/harness-claude-code-v0.1.0...harness-claude-code-v0.2.0) (2026-10-22)


### ⚠ BREAKING CHANGES

* **harness-claude-code:** removed the exports cliTurnDriver, awaitTurn, parseTurnDriver, TURN_DRIVERS, TurnDriverKind, ClaudeArgv, TurnAwaitSpec, readLogSample, LOG_READ_TIMEOUT_MS, LogSample, nextSampleDelay, and AWAIT_EXIT_STEP_TIMEOUT. Also removed TurnDriver.mode and the kind and claudeArgv options of TurnDriverRun and createClaudeCode.
* **sandbox-cloudflare:** consumers must export HarnessSandbox from their Worker, switch wrangler to scheduling_policy durable_object, and update the Dockerfile with sandbox-shim. SANDBOX_OPTIONS is removed from harness-transport-cloudflare. The deploy is one-way.

### Features

* **harness-claude-code:** honour the per-turn model from HarnessV1TurnSettings ([#49](https://github.com/amond-ai/harness/issues/49)) ([5e4b114](https://github.com/amond-ai/harness/commit/5e4b11469ab45ac73c9fe2b21ee40a8cf1e4f5b4)), closes [#45](https://github.com/amond-ai/harness/issues/45)
* **harness-claude-code:** implement HarnessV1Session.doReadHistory ([#60](https://github.com/amond-ai/harness/issues/60)) ([39f96c5](https://github.com/amond-ai/harness/commit/39f96c5b82c06509149ee115cdfae9064de52382))
* **harness-codex-bridge:** run @openai/codex-sdk as a per-turn host in the sandbox ([#17](https://github.com/amond-ai/harness/issues/17)) ([44debbc](https://github.com/amond-ai/harness/commit/44debbcf89e3212c11400198510012c54245471f))
* **run:** let the turn's own verdict decide whether to retry an attempt ([#460](https://github.com/amond-ai/harness/issues/460)) ([0a69bab](https://github.com/amond-ai/harness/commit/0a69bab04c41e19e8078a4e390aa206212d03f9e)), closes [#376](https://github.com/amond-ai/harness/issues/376)
* **sandbox-cloudflare:** migrate to @cloudflare/sandbox 1.0 ([#66](https://github.com/amond-ai/harness/issues/66)) ([1a16796](https://github.com/amond-ai/harness/commit/1a167961dee84492002531ee4fdaa528ac501846))
* **sandbox-cloudflare:** publish the Cloudflare sandbox provider as a package ([#51](https://github.com/amond-ai/harness/issues/51)) ([d2707fe](https://github.com/amond-ai/harness/commit/d2707fe3c15e56aae1fe4da92da969365139c788))
* **sandbox-local:** add a local-process backend for the sandbox contract ([#3](https://github.com/amond-ai/harness/issues/3)) ([321dd10](https://github.com/amond-ai/harness/commit/321dd100d1ed8817be9c1c06308e89c7ab517049))
* **sandbox:** add a Daytona backend and select it with SANDBOX_BACKEND=daytona ([#463](https://github.com/amond-ai/harness/issues/463)) ([248bb4a](https://github.com/amond-ai/harness/commit/248bb4a3be1b1432518d3bf772cd05a02d42bca4))
* **sandbox:** restricted e2b port endpoints and provider-level network policy ([#55](https://github.com/amond-ai/harness/issues/55)) ([974adba](https://github.com/amond-ai/harness/commit/974adba0193e73e37e509d31b60dda0f3025750f))


### Bug Fixes

* confirm a stopped process is the turn's and is gone before releasing it ([#31](https://github.com/amond-ai/harness/issues/31)) ([7857c90](https://github.com/amond-ai/harness/commit/7857c90d95600db27514863332b5d403a84151b0)), closes [#23](https://github.com/amond-ai/harness/issues/23)
* **harness-claude-code:** close the attach round's race and ordering gaps behind a round harness ([#29](https://github.com/amond-ai/harness/issues/29)) ([21d489d](https://github.com/amond-ai/harness/commit/21d489daa06a916c3ffe7d2afdba0b39b4902add)), closes [#21](https://github.com/amond-ai/harness/issues/21)
* **harness-claude-code:** define onFrame as at-least-once across a retried step, keyed by seq ([#33](https://github.com/amond-ai/harness/issues/33)) ([9108b1b](https://github.com/amond-ai/harness/commit/9108b1bc827685c74c233f71d1b0e6303fc87b83))
* port turn-lifecycle and bridge fixes from the extraction source ([#20](https://github.com/amond-ai/harness/issues/20)) ([1dbe227](https://github.com/amond-ai/harness/commit/1dbe22704e501e43a317cc6667577f72220f2e9b))
* **sandbox-daytona:** leave the preview-token header off socket endpoints ([#59](https://github.com/amond-ai/harness/issues/59)) ([fbf6841](https://github.com/amond-ai/harness/commit/fbf68415b13a260e6af8afd77dccc54a5a88f81b)), closes [#57](https://github.com/amond-ai/harness/issues/57)


### Code Refactoring

* **harness-claude-code:** remove the cli turn driver ([#73](https://github.com/amond-ai/harness/issues/73)) ([fb12801](https://github.com/amond-ai/harness/commit/fb12801067a2727ddeed0411ee68f8c74a17b8bb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/harness-protocol bumped to 0.2.0
    * @amond-ai/harness-transport bumped to 0.2.0
    * @amond-ai/sandbox bumped to 0.2.0
