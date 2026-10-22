# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/harness-transport-cloudflare-v0.1.0...harness-transport-cloudflare-v0.2.0) (2026-10-22)


### ⚠ BREAKING CHANGES

* **sandbox-cloudflare:** consumers must export HarnessSandbox from their Worker, switch wrangler to scheduling_policy durable_object, and update the Dockerfile with sandbox-shim. SANDBOX_OPTIONS is removed from harness-transport-cloudflare. The deploy is one-way.

### Features

* **harness:** run the Claude Code harness from a Worker over a Cloudflare Sandbox ([#268](https://github.com/amond-ai/harness/issues/268)) ([d3bb432](https://github.com/amond-ai/harness/commit/d3bb43224e74dff4f6492babaebc13cf3f34dc9f))
* **sandbox-cloudflare:** migrate to @cloudflare/sandbox 1.0 ([#66](https://github.com/amond-ai/harness/issues/66)) ([1a16796](https://github.com/amond-ai/harness/commit/1a167961dee84492002531ee4fdaa528ac501846))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/harness-transport bumped to 0.2.0
