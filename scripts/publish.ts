/**
 * Publish the workspace's packages to npm, in dependency order.
 *
 * ```sh
 * bun scripts/publish.ts --dry-run              # pack everything, publish nothing
 * bun scripts/publish.ts                        # every publishable package
 * bun scripts/publish.ts packages/sandbox       # just these
 * ```
 *
 * CI runs the same file: `release-please` reports which paths it released in
 * `PATHS_RELEASED`, and the script reads that when no path is passed, so the release path and
 * a hand-run publish cannot drift apart.
 *
 * Two things it does that a shell loop in a workflow did not. It publishes in dependency
 * order, because `npm install` of a package whose sibling is not on the registry yet resolves
 * to nothing a consumer can use — the order is computed from the manifests rather than
 * listed, so a new package joins it by existing. And it skips a version already on the
 * registry, which is what makes a re-run after a failure safe: publishing eleven packages is
 * eleven chances to fail on the sixth. A dry run packs those too — inspecting the tarball is
 * the point of it, and after the first release every version is an already-published one.
 *
 * It builds before it packs, rather than trusting whoever ran it to have built first. `dist/`
 * is gitignored, and `bun pm pack` is perfectly happy to pack a manifest whose `files` name a
 * directory that is not there — the result is a tarball carrying a README and no
 * implementation, published and immutable before anyone notices.
 *
 * `bun publish` is not used, here or in CI: it cannot request the OIDC token npm's trusted
 * publishing mints a credential from, nor emit the provenance attestation that follows. So
 * bun packs the tarball and the npm CLI publishes it. Provenance is requested only under
 * GitHub Actions, since npm rejects the flag anywhere else.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'

interface Manifest {
  name: string
  version: string
  private?: boolean
  dependencies?: Record<string, string>
}

const SCOPE = '@amond-ai/'
const PACKAGES_DIR = 'packages'

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const requested = args.filter(argument => !argument.startsWith('--'))

function manifestOf(path: string): Manifest {
  return JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')) as Manifest
}

/** Every package directory, so a new one is publishable from the moment it exists. */
const everyPackage = readdirSync(PACKAGES_DIR)
  .map(entry => join(PACKAGES_DIR, entry))
  .filter(path => manifestOf(path).private !== true)
  .sort()

const selected = requested.length > 0
  ? requested
  : releasedPaths() ?? everyPackage

/**
 * The paths release-please says it released, when CI hands them over. An empty or absent
 * value is not the same as "publish everything": in CI it means this run released nothing,
 * and the job that calls this script is gated on that already.
 */
function releasedPaths(): string[] | null {
  const raw = process.env.PATHS_RELEASED?.trim()
  if (!raw) {
    return null
  }
  const paths = JSON.parse(raw) as string[]
  return paths.length > 0 ? paths : []
}

/**
 * The selection, ordered so a package is published after the siblings it depends on.
 *
 * Only the selection is ordered, not the whole workspace: a sibling outside it was either
 * published by an earlier run or is not part of this release, and either way waiting on it
 * here would deadlock a legitimate partial publish.
 */
function inDependencyOrder(paths: string[]): string[] {
  const byName = new Map(paths.map(path => [manifestOf(path).name, path]))
  const ordered: string[] = []
  const visiting = new Set<string>()

  const visit = (path: string): void => {
    if (ordered.includes(path)) {
      return
    }
    if (visiting.has(path)) {
      throw new Error(`dependency cycle through ${path}`)
    }
    visiting.add(path)
    for (const dependency of Object.keys(manifestOf(path).dependencies ?? {})) {
      if (!dependency.startsWith(SCOPE)) {
        continue
      }
      const sibling = byName.get(dependency)
      if (sibling) {
        visit(sibling)
      }
    }
    visiting.delete(path)
    ordered.push(path)
  }

  for (const path of paths) {
    visit(path)
  }
  return ordered
}

/** Whether this exact version is already on the registry, so a re-run is a no-op for it. */
function alreadyPublished(name: string, version: string): boolean {
  try {
    execFileSync('npm', ['view', `${name}@${version}`, 'version'], { stdio: 'pipe' })
    return true
  }
  catch {
    return false
  }
}

if (selected.length === 0) {
  console.log('nothing to publish')
  process.exit(0)
}

// turbo caches this, so the build CI already ran costs nothing the second time.
execFileSync('bun', ['run', 'build'], { stdio: 'inherit' })

const destination = mkdtempSync(join(tmpdir(), 'harness-publish-'))

for (const path of inDependencyOrder(selected)) {
  const { name, version } = manifestOf(path)

  if (!dryRun && alreadyPublished(name, version)) {
    console.log(`skipping ${name}@${version} — already on the registry`)
    continue
  }

  execFileSync('bun', ['pm', 'pack', '--destination', destination], { cwd: path, stdio: 'inherit' })
  // The name `bun pm pack` writes: the scope flattened, then the version.
  const tarball = join(destination, `${name.replace('@', '').replace('/', '-')}-${version}.tgz`)

  if (dryRun) {
    console.log(`would publish ${name}@${version} from ${tarball}`)
    continue
  }

  const flags = ['--access', 'public']
  if (process.env.GITHUB_ACTIONS === 'true') {
    flags.push('--provenance')
  }

  console.log(`publishing ${name}@${version}`)
  execFileSync('npm', ['publish', tarball, ...flags], { stdio: 'inherit' })
}
