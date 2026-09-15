# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/harness-sandbox-v0.1.0...harness-sandbox-v0.2.0) (2026-09-15)


### Features

* **harness:** run the Claude Code harness from a Worker over a Cloudflare Sandbox ([#268](https://github.com/amond-ai/harness/issues/268)) ([d3bb432](https://github.com/amond-ai/harness/commit/d3bb43224e74dff4f6492babaebc13cf3f34dc9f))


### Bug Fixes

* **harness-sandbox:** stop process.ts awaiting its own cleanup before throwing the abort reason ([#274](https://github.com/amond-ai/harness/issues/274)) ([f5197c7](https://github.com/amond-ai/harness/commit/f5197c7675b137431e0fc2b75c4b99e8c677a555))
* **harness-sandbox:** stop the file surface starting work a caller cancelled ([#272](https://github.com/amond-ai/harness/issues/272)) ([b6a0ce0](https://github.com/amond-ai/harness/commit/b6a0ce0da676e369bc08935d43b2fa179acbf843))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/sandbox bumped to 0.2.0
