import { fileURLToPath } from 'node:url'

/**
 * The repo root, resolved from this file's own location — every workspace config imports from
 * here, so the value stays correct no matter how deep the workspace is.
 */
const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url))

/**
 * Coverage settings shared by every workspace's `vitest.config.ts`.
 *
 * `istanbul`, not `v8`: the suites run under Bun (`bun --bun vitest run`), whose engine is
 * JavaScriptCore and does not produce the V8 coverage profile the `v8` provider reads.
 *
 * `lcovonly`, not `lcov`: the latter also writes an html report into a `lcov-report/` subdir,
 * which is dead output here — nothing consumes it. `projectRoot` is what makes every `SF:`
 * path repo-root-relative, which is the only form the sonar scanner resolves (trap #75; see
 * #79 for the same fix applied to a vitest config).
 *
 * Annotated rather than `as const`: `apps/dashboard` is the one workspace whose `tsconfig.json`
 * includes its own config files, so it typechecks the object this is spread into, and
 * `CoverageOptions.reporter` is a mutable array that a `readonly` tuple cannot be assigned to.
 * The annotation keeps `provider` narrow without freezing the shape.
 */
export const sharedCoverage: {
  provider: 'istanbul'
  reporter: ['text', ['lcovonly', { projectRoot: string }]]
  reportsDirectory: string
} = {
  provider: 'istanbul',
  reporter: [
    'text',
    ['lcovonly', { projectRoot: REPO_ROOT }],
  ],
  reportsDirectory: 'coverage',
}

/**
 * Dependencies Vite must transform itself instead of letting the runtime import them
 * externally.
 *
 * `zod`'s entry re-exports a namespace (`export * as z from './v4/classic/external.js'`).
 * Measured under Bun 1.4.0 + vitest 4.1.10: that binding arrives `undefined`, so
 * `import { z } from 'zod'` fails at module evaluation with "undefined is not an object";
 * the identical import is fine under Node, and `import * as ns` is fine under both. Inlining
 * routes the package through Vite's transform, where the re-export resolves.
 */
export const sharedInlineDeps = ['zod']
