# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/sandbox-e2b-v0.1.0...sandbox-e2b-v0.2.0) (2026-09-15)


### Features

* **harness:** run the Claude Code harness from a Worker over a Cloudflare Sandbox ([#268](https://github.com/amond-ai/harness/issues/268)) ([d3bb432](https://github.com/amond-ai/harness/commit/d3bb43224e74dff4f6492babaebc13cf3f34dc9f))
* **sandbox-e2b:** build an e2b template that carries the turn host ([#390](https://github.com/amond-ai/harness/issues/390)) ([28980d3](https://github.com/amond-ai/harness/commit/28980d34bc4dcb7e3a88a6d9eaf862b4abf2aacd))
* **sandbox:** own the sandbox contract and add an e2b backend ([#260](https://github.com/amond-ai/harness/issues/260)) ([39face2](https://github.com/amond-ai/harness/commit/39face24d2050c1b09b10038e94c3c36cbceea19))
* **turn-host:** interrupt turns with SIGINT and bake the Agent SDK turn host into the image ([#372](https://github.com/amond-ai/harness/issues/372)) ([a582682](https://github.com/amond-ai/harness/commit/a582682e16b98036a30a5fc525a6abf425c81958))


### Bug Fixes

* **sandbox-e2b:** answer discovery calls without creating a sandbox ([#469](https://github.com/amond-ai/harness/issues/469)) ([d0b4d30](https://github.com/amond-ai/harness/commit/d0b4d301cb49fa4b9f73e860fc6b0edafcbacf76))
* **sandbox-e2b:** follow a live process in logs(), proven by the first end-to-end harness run ([#280](https://github.com/amond-ai/harness/issues/280)) ([f59b2a0](https://github.com/amond-ai/harness/commit/f59b2a085d18f461a6b5b90f6b927e4a3b78c514))
* **sandbox-e2b:** supervise a turn by its own session so a detached child cannot forge an exit ([#276](https://github.com/amond-ai/harness/issues/276)) ([3afeed0](https://github.com/amond-ai/harness/commit/3afeed03a6a32dd8c6a97436ebacb4fb57838bdc))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/sandbox bumped to 0.2.0
