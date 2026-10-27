# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/sandbox-e2b-v0.1.0...sandbox-e2b-v0.2.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* **harness-claude-code:** removed the exports cliTurnDriver, awaitTurn, parseTurnDriver, TURN_DRIVERS, TurnDriverKind, ClaudeArgv, TurnAwaitSpec, readLogSample, LOG_READ_TIMEOUT_MS, LogSample, nextSampleDelay, and AWAIT_EXIT_STEP_TIMEOUT. Also removed TurnDriver.mode and the kind and claudeArgv options of TurnDriverRun and createClaudeCode.

### Features

* **harness:** run the Claude Code harness from a Worker over a Cloudflare Sandbox ([#268](https://github.com/amond-ai/harness/issues/268)) ([d3bb432](https://github.com/amond-ai/harness/commit/d3bb43224e74dff4f6492babaebc13cf3f34dc9f))
* **sandbox-e2b:** build an e2b template that carries the turn host ([#390](https://github.com/amond-ai/harness/issues/390)) ([28980d3](https://github.com/amond-ai/harness/commit/28980d34bc4dcb7e3a88a6d9eaf862b4abf2aacd))
* **sandbox:** own the sandbox contract and add an e2b backend ([#260](https://github.com/amond-ai/harness/issues/260)) ([39face2](https://github.com/amond-ai/harness/commit/39face24d2050c1b09b10038e94c3c36cbceea19))
* **sandbox:** restricted e2b port endpoints and provider-level network policy ([#55](https://github.com/amond-ai/harness/issues/55)) ([974adba](https://github.com/amond-ai/harness/commit/974adba0193e73e37e509d31b60dda0f3025750f))
* **turn-host:** interrupt turns with SIGINT and bake the Agent SDK turn host into the image ([#372](https://github.com/amond-ai/harness/issues/372)) ([a582682](https://github.com/amond-ai/harness/commit/a582682e16b98036a30a5fc525a6abf425c81958))


### Bug Fixes

* port turn-lifecycle and bridge fixes from the extraction source ([#20](https://github.com/amond-ai/harness/issues/20)) ([1dbe227](https://github.com/amond-ai/harness/commit/1dbe22704e501e43a317cc6667577f72220f2e9b))
* **sandbox-e2b:** answer discovery calls without creating a sandbox ([#469](https://github.com/amond-ai/harness/issues/469)) ([d0b4d30](https://github.com/amond-ai/harness/commit/d0b4d301cb49fa4b9f73e860fc6b0edafcbacf76))
* **sandbox-e2b:** follow a live process in logs(), proven by the first end-to-end harness run ([#280](https://github.com/amond-ai/harness/issues/280)) ([f59b2a0](https://github.com/amond-ai/harness/commit/f59b2a085d18f461a6b5b90f6b927e4a3b78c514))
* **sandbox-e2b:** supervise a turn by its own session so a detached child cannot forge an exit ([#276](https://github.com/amond-ai/harness/issues/276)) ([3afeed0](https://github.com/amond-ai/harness/commit/3afeed03a6a32dd8c6a97436ebacb4fb57838bdc))
* **sandbox-e2b:** surface an open failure in the whole-transcript read ([#36](https://github.com/amond-ai/harness/issues/36)) ([6dbee53](https://github.com/amond-ai/harness/commit/6dbee53cfdf1cc2918c22473a22d7791504bdd1a)), closes [#28](https://github.com/amond-ai/harness/issues/28)
* **sandbox:** propagate cancellation and failures to the journal reads ([#30](https://github.com/amond-ai/harness/issues/30)) ([ffc39e9](https://github.com/amond-ai/harness/commit/ffc39e95c3f5a34d3d03f097667ddb1462e3252f)), closes [#22](https://github.com/amond-ai/harness/issues/22)
* **sandbox:** share the backends' shell quoting through @amond-ai/sandbox/journal ([#79](https://github.com/amond-ai/harness/issues/79)) ([0ae160b](https://github.com/amond-ai/harness/commit/0ae160bc12fb29250418e2cd86468e752cc84c27)), closes [#6](https://github.com/amond-ai/harness/issues/6)
* **sandbox:** thread the abort signal through whole-transcript journal reads ([#77](https://github.com/amond-ai/harness/issues/77)) ([08952f3](https://github.com/amond-ai/harness/commit/08952f394d378b82878c1adab11cacee14ef5ae9)), closes [#69](https://github.com/amond-ai/harness/issues/69)


### Code Refactoring

* **harness-claude-code:** remove the cli turn driver ([#73](https://github.com/amond-ai/harness/issues/73)) ([fb12801](https://github.com/amond-ai/harness/commit/fb12801067a2727ddeed0411ee68f8c74a17b8bb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/sandbox bumped to 0.2.0
