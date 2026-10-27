# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/sandbox-daytona-v0.1.0...sandbox-daytona-v0.2.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* **harness-claude-code:** removed the exports cliTurnDriver, awaitTurn, parseTurnDriver, TURN_DRIVERS, TurnDriverKind, ClaudeArgv, TurnAwaitSpec, readLogSample, LOG_READ_TIMEOUT_MS, LogSample, nextSampleDelay, and AWAIT_EXIT_STEP_TIMEOUT. Also removed TurnDriver.mode and the kind and claudeArgv options of TurnDriverRun and createClaudeCode.

### Features

* **sandbox:** add a Daytona backend and select it with SANDBOX_BACKEND=daytona ([#463](https://github.com/amond-ai/harness/issues/463)) ([248bb4a](https://github.com/amond-ai/harness/commit/248bb4a3be1b1432518d3bf772cd05a02d42bca4))


### Bug Fixes

* confirm a stopped process is the turn's and is gone before releasing it ([#31](https://github.com/amond-ai/harness/issues/31)) ([7857c90](https://github.com/amond-ai/harness/commit/7857c90d95600db27514863332b5d403a84151b0)), closes [#23](https://github.com/amond-ai/harness/issues/23)
* **sandbox-daytona:** leave the preview-token header off socket endpoints ([#59](https://github.com/amond-ai/harness/issues/59)) ([fbf6841](https://github.com/amond-ai/harness/commit/fbf68415b13a260e6af8afd77dccc54a5a88f81b)), closes [#57](https://github.com/amond-ai/harness/issues/57)
* **sandbox:** honour the caller's signal on the Daytona, local and Vercel positioned reads ([#35](https://github.com/amond-ai/harness/issues/35)) ([bd2d00e](https://github.com/amond-ai/harness/commit/bd2d00edca7426afe4a375b4db7de5940ec221f4)), closes [#27](https://github.com/amond-ai/harness/issues/27)
* **sandbox:** settle a Daytona sandbox caught archiving or pausing before waking it ([#470](https://github.com/amond-ai/harness/issues/470)) ([9aa485a](https://github.com/amond-ai/harness/commit/9aa485a313eec34870c05ac42b5d3060f0afc398))
* **sandbox:** share the backends' shell quoting through @amond-ai/sandbox/journal ([#79](https://github.com/amond-ai/harness/issues/79)) ([0ae160b](https://github.com/amond-ai/harness/commit/0ae160bc12fb29250418e2cd86468e752cc84c27)), closes [#6](https://github.com/amond-ai/harness/issues/6)
* **sandbox:** thread the abort signal through whole-transcript journal reads ([#77](https://github.com/amond-ai/harness/issues/77)) ([08952f3](https://github.com/amond-ai/harness/commit/08952f394d378b82878c1adab11cacee14ef5ae9)), closes [#69](https://github.com/amond-ai/harness/issues/69)


### Code Refactoring

* **harness-claude-code:** remove the cli turn driver ([#73](https://github.com/amond-ai/harness/issues/73)) ([fb12801](https://github.com/amond-ai/harness/commit/fb12801067a2727ddeed0411ee68f8c74a17b8bb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/sandbox bumped to 0.2.0
