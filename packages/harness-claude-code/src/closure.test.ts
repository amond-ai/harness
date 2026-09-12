/**
 * The seam's dependency closure, asserted rather than remembered.
 *
 * These packages live in a repository of their own, which only holds while none of them reaches
 * for anything outside the set: an `apps/*` import, the orchestrator's `agent-core`, the
 * CLI-spawning `sandbox-bridge`, a dashboard schema. Each of those would be invisible until
 * something tried to build the set somewhere else, so the check runs here, on every test run,
 * where a `workspace:*` line added by hand fails immediately.
 *
 * The set carries its own scope, `@amond-ai`, which makes the second assertion below possible and
 * necessary at once: inside the set a dependency is named by scope, so a `@pleaseai/…` line in one
 * of these manifests is by construction a reach back into the repository being left behind. The
 * one exception is `@pleaseai/eslint-config`, which is published rather than a sibling tree.
 *
 * The third assertion is the one the transport split exists to keep true. Only two members are
 * allowed to know what they run on: `harness-transport-cloudflare`, whose whole subject is
 * workerd, and `harness-claude-code-bridge`, which is a Node process inside the sandbox image.
 * Every other member has to run wherever a `WebSocket` and a `fetch` do — that is what makes the
 * driver usable off Cloudflare — so a `@cloudflare/*` dependency or a `cloudflare:`/`node:`/`bun:`
 * import in one of them is the regression, and it is the kind that typechecks perfectly until
 * somebody tries the other runtime.
 *
 * External dependencies are otherwise unconstrained on purpose: they are declared through the root
 * catalog and travel with a `package.json`, so `@cloudflare/sandbox` under
 * `harness-transport-cloudflare` costs the split nothing.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/** `packages/harness-claude-code/src` → `packages`, two levels up. */
const SET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')

/**
 * The set is the directory. Every package under `packages` is a member, so a new one is
 * held to the assertions below from the moment it exists, rather than from whenever somebody
 * remembers to name it here — the omission a hand-kept list invites, and one that nothing
 * else would catch.
 */
const CLOSED_SET = readdirSync(SET_ROOT)
  .filter(entry => existsSync(join(SET_ROOT, entry, 'package.json')))
  .sort()

/** The two members whose subject *is* a runtime: workerd, and the Node process in the image. */
const RUNTIME_SPECIFIC = new Set<string>(['harness-transport-cloudflare', 'harness-claude-code-bridge'])

/**
 * The one `@pleaseai` name allowed inside the set: the shared ESLint config, which is a published
 * package rather than a sibling source tree — it resolves from npm wherever these end up, so it is
 * an external dependency that happens to carry the old org scope.
 */
const EXTERNAL_ORG_PACKAGES = new Set(['@pleaseai/eslint-config'])

const MEMBER_NAMES = new Set(CLOSED_SET.map(name => `@amond-ai/${name}`))

/** A runtime-specific import: the three module namespaces only one runtime family answers. */
const RUNTIME_IMPORT = /from\s+'(cloudflare:[^']*|node:[^']*|bun:[^']*)'/g

function manifestOf(pkg: string): { dependencies?: Record<string, string>, devDependencies?: Record<string, string>, peerDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(join(SET_ROOT, pkg, 'package.json'), 'utf8')) as never
}

function dependencyNamesOf(pkg: string): string[] {
  const manifest = manifestOf(pkg)
  return [
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.devDependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
  ]
}

function scopedDependenciesOf(pkg: string): string[] {
  return dependencyNamesOf(pkg)
    .filter(name => name.startsWith('@amond-ai/') || name.startsWith('@pleaseai/'))
}

/** Every non-test `.ts` file under a member's `src`, so a fixture cannot fail the runtime check. */
function sourceFilesOf(pkg: string): string[] {
  const walk = (directory: string): string[] => readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry)
    if (statSync(path).isDirectory()) {
      return walk(path)
    }
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : []
  })
  return walk(join(SET_ROOT, pkg, 'src'))
}

describe('the turn seam\'s dependency closure', () => {
  it.each(CLOSED_SET)('keeps %s inside the set', (pkg) => {
    const outside = scopedDependenciesOf(pkg)
      .filter(name => !EXTERNAL_ORG_PACKAGES.has(name))
      .filter(name => !MEMBER_NAMES.has(name))

    expect(outside).toEqual([])
  })

  it.each(CLOSED_SET)('leaves %s with no @pleaseai dependency but the published eslint config', (pkg) => {
    const left = scopedDependenciesOf(pkg)
      .filter(name => name.startsWith('@pleaseai/'))
      .filter(name => !EXTERNAL_ORG_PACKAGES.has(name))

    expect(left).toEqual([])
  })

  it.each(CLOSED_SET.filter(pkg => !RUNTIME_SPECIFIC.has(pkg)))('leaves %s able to run on any runtime', (pkg) => {
    const cloudflareDeps = dependencyNamesOf(pkg).filter(name => name.startsWith('@cloudflare/'))
    const runtimeImports = sourceFilesOf(pkg).flatMap(file =>
      [...readFileSync(file, 'utf8').matchAll(RUNTIME_IMPORT)].map(match => `${file}: ${match[1]}`))

    expect({ cloudflareDeps, runtimeImports }).toEqual({ cloudflareDeps: [], runtimeImports: [] })
  })

  /*
   * The set is scanned rather than listed, and an empty scan would leave every assertion above
   * with nothing to run and the suite green. This is what fails in that case instead.
   */
  it('finds the whole set on disk', () => {
    expect(CLOSED_SET).toContain('harness-claude-code')
    expect(CLOSED_SET.length).toBeGreaterThanOrEqual(10)
  })
})
