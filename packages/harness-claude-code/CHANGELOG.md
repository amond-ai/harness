# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/harness-claude-code-v0.1.0...harness-claude-code-v0.2.0) (2026-10-17)


### Features

* **harness-codex-bridge:** run @openai/codex-sdk as a per-turn host in the sandbox ([#17](https://github.com/amond-ai/harness/issues/17)) ([44debbc](https://github.com/amond-ai/harness/commit/44debbcf89e3212c11400198510012c54245471f))
* **run:** let the turn's own verdict decide whether to retry an attempt ([#460](https://github.com/amond-ai/harness/issues/460)) ([0a69bab](https://github.com/amond-ai/harness/commit/0a69bab04c41e19e8078a4e390aa206212d03f9e)), closes [#376](https://github.com/amond-ai/harness/issues/376)
* **sandbox-local:** add a local-process backend for the sandbox contract ([#3](https://github.com/amond-ai/harness/issues/3)) ([321dd10](https://github.com/amond-ai/harness/commit/321dd100d1ed8817be9c1c06308e89c7ab517049))
* **sandbox:** add a Daytona backend and select it with SANDBOX_BACKEND=daytona ([#463](https://github.com/amond-ai/harness/issues/463)) ([248bb4a](https://github.com/amond-ai/harness/commit/248bb4a3be1b1432518d3bf772cd05a02d42bca4))


### Bug Fixes

* confirm a stopped process is the turn's and is gone before releasing it ([#31](https://github.com/amond-ai/harness/issues/31)) ([7857c90](https://github.com/amond-ai/harness/commit/7857c90d95600db27514863332b5d403a84151b0)), closes [#23](https://github.com/amond-ai/harness/issues/23)
* **harness-claude-code:** close the attach round's race and ordering gaps behind a round harness ([#29](https://github.com/amond-ai/harness/issues/29)) ([21d489d](https://github.com/amond-ai/harness/commit/21d489daa06a916c3ffe7d2afdba0b39b4902add)), closes [#21](https://github.com/amond-ai/harness/issues/21)
* **harness-claude-code:** define onFrame as at-least-once across a retried step, keyed by seq ([#33](https://github.com/amond-ai/harness/issues/33)) ([9108b1b](https://github.com/amond-ai/harness/commit/9108b1bc827685c74c233f71d1b0e6303fc87b83))
* port turn-lifecycle and bridge fixes from the extraction source ([#20](https://github.com/amond-ai/harness/issues/20)) ([1dbe227](https://github.com/amond-ai/harness/commit/1dbe22704e501e43a317cc6667577f72220f2e9b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/harness-protocol bumped to 0.2.0
    * @amond-ai/sandbox bumped to 0.2.0
