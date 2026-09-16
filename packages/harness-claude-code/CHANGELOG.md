# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/harness-claude-code-v0.1.0...harness-claude-code-v0.2.0) (2026-09-16)


### Features

* **harness-codex-bridge:** run @openai/codex-sdk as a per-turn host in the sandbox ([#17](https://github.com/amond-ai/harness/issues/17)) ([44debbc](https://github.com/amond-ai/harness/commit/44debbcf89e3212c11400198510012c54245471f))
* **run:** let the turn's own verdict decide whether to retry an attempt ([#460](https://github.com/amond-ai/harness/issues/460)) ([0a69bab](https://github.com/amond-ai/harness/commit/0a69bab04c41e19e8078a4e390aa206212d03f9e)), closes [#376](https://github.com/amond-ai/harness/issues/376)
* **sandbox-local:** add a local-process backend for the sandbox contract ([#3](https://github.com/amond-ai/harness/issues/3)) ([321dd10](https://github.com/amond-ai/harness/commit/321dd100d1ed8817be9c1c06308e89c7ab517049))
* **sandbox:** add a Daytona backend and select it with SANDBOX_BACKEND=daytona ([#463](https://github.com/amond-ai/harness/issues/463)) ([248bb4a](https://github.com/amond-ai/harness/commit/248bb4a3be1b1432518d3bf772cd05a02d42bca4))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/harness-protocol bumped to 0.2.0
    * @amond-ai/sandbox bumped to 0.2.0
