# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/harness-codex-bridge-v0.1.0...harness-codex-bridge-v0.2.0) (2026-10-22)


### Features

* **harness-codex-bridge:** run @openai/codex-sdk as a per-turn host in the sandbox ([#17](https://github.com/amond-ai/harness/issues/17)) ([44debbc](https://github.com/amond-ai/harness/commit/44debbcf89e3212c11400198510012c54245471f))
* re-vendor the AI SDK harness packages to @ai-sdk/harness@1.0.158 ([#40](https://github.com/amond-ai/harness/issues/40)) ([6caeba0](https://github.com/amond-ai/harness/commit/6caeba0b3f885f6243453a35b1622590b0d62aad))


### Bug Fixes

* **harness-codex-bridge:** pair the call and result of id-less command and MCP items ([#56](https://github.com/amond-ai/harness/issues/56)) ([1fc6e1a](https://github.com/amond-ai/harness/commit/1fc6e1a81a33a5d5047558f2a010193519cb1686)), closes [#47](https://github.com/amond-ai/harness/issues/47)
* port turn-lifecycle and bridge fixes from the extraction source ([#20](https://github.com/amond-ai/harness/issues/20)) ([1dbe227](https://github.com/amond-ai/harness/commit/1dbe22704e501e43a317cc6667577f72220f2e9b))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/harness-bridge-runtime bumped to 0.2.0
    * @amond-ai/harness-protocol bumped to 0.2.0
