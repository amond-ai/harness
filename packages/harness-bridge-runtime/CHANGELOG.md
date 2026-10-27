# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/harness-bridge-runtime-v0.1.0...harness-bridge-runtime-v0.2.0) (2026-10-27)


### Features

* **harness-codex-bridge:** run @openai/codex-sdk as a per-turn host in the sandbox ([#17](https://github.com/amond-ai/harness/issues/17)) ([44debbc](https://github.com/amond-ai/harness/commit/44debbcf89e3212c11400198510012c54245471f))
* re-vendor the AI SDK harness packages to @ai-sdk/harness@1.0.158 ([#40](https://github.com/amond-ai/harness/issues/40)) ([6caeba0](https://github.com/amond-ai/harness/commit/6caeba0b3f885f6243453a35b1622590b0d62aad))


### Bug Fixes

* **harness-bridge-runtime:** fence a late tool result by match identity across turns ([#32](https://github.com/amond-ai/harness/issues/32)) ([7181f33](https://github.com/amond-ai/harness/commit/7181f3350ae5323c7d9e2c7a0b19ad10bac8b608)), closes [#24](https://github.com/amond-ai/harness/issues/24)
* **harness-bridge-runtime:** ship the Apache-2.0 LICENSE in the package ([#81](https://github.com/amond-ai/harness/issues/81)) ([30250dd](https://github.com/amond-ai/harness/commit/30250ddf60ff1ec73c5709b4c6b3460bfaa02271))
* port turn-lifecycle and bridge fixes from the extraction source ([#20](https://github.com/amond-ai/harness/issues/20)) ([1dbe227](https://github.com/amond-ai/harness/commit/1dbe22704e501e43a317cc6667577f72220f2e9b))


### Dependencies

* The following workspace dependencies were updated
  * devDependencies
    * @amond-ai/harness-protocol bumped to 0.2.0
