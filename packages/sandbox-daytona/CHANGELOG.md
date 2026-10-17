# Changelog

## [0.2.0](https://github.com/amond-ai/harness/compare/sandbox-daytona-v0.1.0...sandbox-daytona-v0.2.0) (2026-10-17)


### Features

* **sandbox:** add a Daytona backend and select it with SANDBOX_BACKEND=daytona ([#463](https://github.com/amond-ai/harness/issues/463)) ([248bb4a](https://github.com/amond-ai/harness/commit/248bb4a3be1b1432518d3bf772cd05a02d42bca4))


### Bug Fixes

* confirm a stopped process is the turn's and is gone before releasing it ([#31](https://github.com/amond-ai/harness/issues/31)) ([7857c90](https://github.com/amond-ai/harness/commit/7857c90d95600db27514863332b5d403a84151b0)), closes [#23](https://github.com/amond-ai/harness/issues/23)
* **sandbox:** honour the caller's signal on the Daytona, local and Vercel positioned reads ([#35](https://github.com/amond-ai/harness/issues/35)) ([bd2d00e](https://github.com/amond-ai/harness/commit/bd2d00edca7426afe4a375b4db7de5940ec221f4)), closes [#27](https://github.com/amond-ai/harness/issues/27)
* **sandbox:** settle a Daytona sandbox caught archiving or pausing before waking it ([#470](https://github.com/amond-ai/harness/issues/470)) ([9aa485a](https://github.com/amond-ai/harness/commit/9aa485a313eec34870c05ac42b5d3060f0afc398))


### Dependencies

* The following workspace dependencies were updated
  * dependencies
    * @amond-ai/sandbox bumped to 0.2.0
