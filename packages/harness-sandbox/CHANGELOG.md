# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/harness-sandbox-v0.1.0...harness-sandbox-v0.2.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* **sandbox-cloudflare:** consumers must export HarnessSandbox from their Worker, switch wrangler to scheduling_policy durable_object, and update the Dockerfile with sandbox-shim. SANDBOX_OPTIONS is removed from harness-transport-cloudflare. The deploy is one-way.

### Features

* **harness:** run the Claude Code harness from a Worker over a Cloudflare Sandbox ([#268](https://github.com/amond-ai/harness/issues/268)) ([d3bb432](https://github.com/amond-ai/harness/commit/d3bb43224e74dff4f6492babaebc13cf3f34dc9f))
* **sandbox-cloudflare:** migrate to @cloudflare/sandbox 1.0 ([#66](https://github.com/amond-ai/harness/issues/66)) ([1a16796](https://github.com/amond-ai/harness/commit/1a167961dee84492002531ee4fdaa528ac501846))
* **sandbox:** restricted e2b port endpoints and provider-level network policy ([#55](https://github.com/amond-ai/harness/issues/55)) ([974adba](https://github.com/amond-ai/harness/commit/974adba0193e73e37e509d31b60dda0f3025750f))


### Bug Fixes

* **harness-sandbox:** stop process.ts awaiting its own cleanup before throwing the abort reason ([#274](https://github.com/amond-ai/harness/issues/274)) ([f5197c7](https://github.com/amond-ai/harness/commit/f5197c7675b137431e0fc2b75c4b99e8c677a555))
* **harness-sandbox:** stop the file surface starting work a caller cancelled ([#272](https://github.com/amond-ai/harness/issues/272)) ([b6a0ce0](https://github.com/amond-ai/harness/commit/b6a0ce0da676e369bc08935d43b2fa179acbf843))
* **sandbox:** share the backends' shell quoting through @amond-ai/sandbox/journal ([#79](https://github.com/amond-ai/harness/issues/79)) ([0ae160b](https://github.com/amond-ai/harness/commit/0ae160bc12fb29250418e2cd86468e752cc84c27)), closes [#6](https://github.com/amond-ai/harness/issues/6)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/sandbox bumped to 0.2.0
