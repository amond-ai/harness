# Changelog

## [0.2.1](https://github.com/amond-ai/harness/compare/sandbox-local-v0.2.0...sandbox-local-v0.2.1) (2026-10-27)


### Bug Fixes

* **sandbox:** thread the abort signal through Vercel and local whole-transcript replays ([#82](https://github.com/amond-ai/harness/issues/82)) ([e962d87](https://github.com/amond-ai/harness/commit/e962d87168191623d05a1b4be756399f63ece38f)), closes [#80](https://github.com/amond-ai/harness/issues/80)

## [0.2.0](https://github.com/amond-ai/harness/compare/sandbox-local-v0.1.0...sandbox-local-v0.2.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* **harness-claude-code:** removed the exports cliTurnDriver, awaitTurn, parseTurnDriver, TURN_DRIVERS, TurnDriverKind, ClaudeArgv, TurnAwaitSpec, readLogSample, LOG_READ_TIMEOUT_MS, LogSample, nextSampleDelay, and AWAIT_EXIT_STEP_TIMEOUT. Also removed TurnDriver.mode and the kind and claudeArgv options of TurnDriverRun and createClaudeCode.
* **sandbox-local:** four public signatures of `@amond-ai/sandbox-local` change.
    - `journalledScript(argv, paths, nonce, timeout?)` — new required third parameter
    - `parseJournalScript(line, stateDir, nonce)` — new required third parameter
    - `ProcessRegistry.ensure()` now returns `Promise<string>` (the nonce) instead of
      `Promise<void>`
    - `LocalHost` gains a required `createFile(path, data): Promise<boolean>` method

### Features

* **sandbox-local:** add a local-process backend for the sandbox contract ([#3](https://github.com/amond-ai/harness/issues/3)) ([321dd10](https://github.com/amond-ai/harness/commit/321dd100d1ed8817be9c1c06308e89c7ab517049))


### Bug Fixes

* **sandbox-local:** bind the wrapper marker to a per-sandbox nonce ([#19](https://github.com/amond-ai/harness/issues/19)) ([6bccbac](https://github.com/amond-ai/harness/commit/6bccbac040ad3e3593c95e6b326b45f5dc8b02b9))
* **sandbox:** honour the caller's signal on the Daytona, local and Vercel positioned reads ([#35](https://github.com/amond-ai/harness/issues/35)) ([bd2d00e](https://github.com/amond-ai/harness/commit/bd2d00edca7426afe4a375b4db7de5940ec221f4)), closes [#27](https://github.com/amond-ai/harness/issues/27)
* **sandbox:** share the backends' shell quoting through @amond-ai/sandbox/journal ([#79](https://github.com/amond-ai/harness/issues/79)) ([0ae160b](https://github.com/amond-ai/harness/commit/0ae160bc12fb29250418e2cd86468e752cc84c27)), closes [#6](https://github.com/amond-ai/harness/issues/6)


### Code Refactoring

* **harness-claude-code:** remove the cli turn driver ([#73](https://github.com/amond-ai/harness/issues/73)) ([fb12801](https://github.com/amond-ai/harness/commit/fb12801067a2727ddeed0411ee68f8c74a17b8bb))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/sandbox bumped to 0.2.0
