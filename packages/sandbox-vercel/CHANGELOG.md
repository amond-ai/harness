# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/sandbox-vercel-v0.1.0...sandbox-vercel-v0.2.0) (2026-10-22)


### ⚠ BREAKING CHANGES

* **harness-claude-code:** removed the exports cliTurnDriver, awaitTurn, parseTurnDriver, TURN_DRIVERS, TurnDriverKind, ClaudeArgv, TurnAwaitSpec, readLogSample, LOG_READ_TIMEOUT_MS, LogSample, nextSampleDelay, and AWAIT_EXIT_STEP_TIMEOUT. Also removed TurnDriver.mode and the kind and claudeArgv options of TurnDriverRun and createClaudeCode.

### Features

* **sandbox-vercel:** add a Vercel Sandbox backend for the sandbox contract ([#14](https://github.com/amond-ai/harness/issues/14)) ([f20b7d6](https://github.com/amond-ai/harness/commit/f20b7d6f30286a5540efef843f5451164544013d))


### Bug Fixes

* **sandbox:** honour the caller's signal on the Daytona, local and Vercel positioned reads ([#35](https://github.com/amond-ai/harness/issues/35)) ([bd2d00e](https://github.com/amond-ai/harness/commit/bd2d00edca7426afe4a375b4db7de5940ec221f4)), closes [#27](https://github.com/amond-ai/harness/issues/27)


### Code Refactoring

* **harness-claude-code:** remove the cli turn driver ([#73](https://github.com/amond-ai/harness/issues/73)) ([fb12801](https://github.com/amond-ai/harness/commit/fb12801067a2727ddeed0411ee68f8c74a17b8bb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/sandbox bumped to 0.2.0
