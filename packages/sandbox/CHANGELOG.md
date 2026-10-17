# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/sandbox-v0.1.0...sandbox-v0.2.0) (2026-10-17)


### Features

* **harness:** run the Claude Code harness from a Worker over a Cloudflare Sandbox ([#268](https://github.com/amond-ai/harness/issues/268)) ([d3bb432](https://github.com/amond-ai/harness/commit/d3bb43224e74dff4f6492babaebc13cf3f34dc9f))
* **sandbox:** own the sandbox contract and add an e2b backend ([#260](https://github.com/amond-ai/harness/issues/260)) ([39face2](https://github.com/amond-ai/harness/commit/39face24d2050c1b09b10038e94c3c36cbceea19))
* **turn-host:** interrupt turns with SIGINT and bake the Agent SDK turn host into the image ([#372](https://github.com/amond-ai/harness/issues/372)) ([a582682](https://github.com/amond-ai/harness/commit/a582682e16b98036a30a5fc525a6abf425c81958))


### Bug Fixes

* port turn-lifecycle and bridge fixes from the extraction source ([#20](https://github.com/amond-ai/harness/issues/20)) ([1dbe227](https://github.com/amond-ai/harness/commit/1dbe22704e501e43a317cc6667577f72220f2e9b))
* **sandbox-e2b:** answer discovery calls without creating a sandbox ([#469](https://github.com/amond-ai/harness/issues/469)) ([d0b4d30](https://github.com/amond-ai/harness/commit/d0b4d301cb49fa4b9f73e860fc6b0edafcbacf76))
* **sandbox:** propagate cancellation and failures to the journal reads ([#30](https://github.com/amond-ai/harness/issues/30)) ([ffc39e9](https://github.com/amond-ai/harness/commit/ffc39e95c3f5a34d3d03f097667ddb1462e3252f)), closes [#22](https://github.com/amond-ai/harness/issues/22)
