# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/sandbox-cloudflare-v0.1.0...sandbox-cloudflare-v0.2.0) (2026-10-27)


### ⚠ BREAKING CHANGES

* **sandbox-cloudflare:** consumers must export HarnessSandbox from their Worker, switch wrangler to scheduling_policy durable_object, and update the Dockerfile with sandbox-shim. SANDBOX_OPTIONS is removed from harness-transport-cloudflare. The deploy is one-way.

### Features

* **sandbox-cloudflare:** migrate to @cloudflare/sandbox 1.0 ([#66](https://github.com/amond-ai/harness/issues/66)) ([1a16796](https://github.com/amond-ai/harness/commit/1a167961dee84492002531ee4fdaa528ac501846))
* **sandbox-cloudflare:** publish the Cloudflare sandbox provider as a package ([#51](https://github.com/amond-ai/harness/issues/51)) ([d2707fe](https://github.com/amond-ai/harness/commit/d2707fe3c15e56aae1fe4da92da969365139c788))


### Bug Fixes

* **sandbox:** thread the abort signal through whole-transcript journal reads ([#77](https://github.com/amond-ai/harness/issues/77)) ([08952f3](https://github.com/amond-ai/harness/commit/08952f394d378b82878c1adab11cacee14ef5ae9)), closes [#69](https://github.com/amond-ai/harness/issues/69)


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/harness-transport-cloudflare bumped to 0.2.0
    * @amond-ai/sandbox bumped to 0.2.0
  * devDependencies
    * @amond-ai/harness-sandbox bumped to 0.2.0
