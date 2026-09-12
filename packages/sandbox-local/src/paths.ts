/**
 * Where a sandbox id lands on disk, and the two rules that keep `destroy()` from taking
 * something with it.
 *
 * **The working directory is the provider's or the caller's, never both.** By default an id
 * resolves to a directory the provider created under its own root, and `destroy()` removes
 * it. A consumer that already has a workspace layout passes `resolveRoot`, and the directory
 * it names is then *not* owned: `destroy()` still ends the sandbox's processes and still
 * removes the provider's own bookkeeping, but it does not delete a tree it was merely pointed
 * at. Ownership is decided here, at resolution, rather than argued about at deletion.
 *
 * **The bookkeeping never lives inside the working directory.** Journals and process records
 * go under a state root of the provider's own, keyed by sandbox id. That is what makes the
 * first rule implementable — an unowned working directory has nothing of ours in it to
 * strand — and it is also the answer to the hazard that is invisible until the second
 * concurrent session: anything shared between sandboxes (a bootstrap, a package store, a
 * bridge bundle) belongs beside them under the root, and a `destroy()` written as "remove the
 * working directory" would take it out from under everyone. Nothing here removes the root, or
 * the state root, or anything but the one sandbox's own two directories.
 */

/**
 * The characters a sandbox or process id may use.
 *
 * Validated rather than escaped, exactly as the e2b backend validates its process ids: an id
 * is interpolated into a filesystem path, the ids in play are opaque tokens minted by the
 * orchestrator, and anything outside this set means a caller passed something it should not
 * have — including the `../` that would resolve outside the root. It also keeps every id
 * distinct from {@link STATE_DIRECTORY_NAME}, which starts with a dot and so can never
 * collide with a sandbox directory under the same root.
 */
const ID_PATTERN = /^[\w-]+$/

export function isSandboxId(value: string): boolean {
  return ID_PATTERN.test(value)
}

export function isProcessId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/** The default state root's name under the provider root. Not a legal id, by construction. */
export const STATE_DIRECTORY_NAME = '.state'

export interface SandboxPaths {
  /** The sandbox's working directory: what `cwd` and every file path resolve against. */
  work: string
  /** This sandbox's bookkeeping — journals and process records. Always the provider's. */
  state: string
  /** Whether `destroy()` may remove {@link work}. False whenever the caller named it. */
  owned: boolean
}

export interface SandboxLayout {
  /** Provider-owned sandbox directories live directly under this. */
  root: string
  /** Bookkeeping root. Defaults to `<root>/.state`. */
  stateRoot?: string
  /** Names the working directory for an id, giving up ownership of it. */
  resolveRoot?: (sandboxId: string) => string
}

/** Strip trailing separators so a joined path never doubles them. */
export function trimTrailingSlash(path: string): string {
  const trimmed = path.replace(/\/+$/, '')
  // `/` trims to the empty string, which would then join as a relative path.
  return trimmed === '' ? path.slice(0, 1) : trimmed
}

export function sandboxPaths(layout: SandboxLayout, sandboxId: string): SandboxPaths {
  if (!isSandboxId(sandboxId)) {
    throw new Error(`invalid sandbox id '${sandboxId}': expected [A-Za-z0-9_-]+`)
  }
  const root = trimTrailingSlash(layout.root)
  const stateRoot = trimTrailingSlash(layout.stateRoot ?? `${root}/${STATE_DIRECTORY_NAME}`)
  const named = layout.resolveRoot?.(sandboxId)
  return {
    work: named === undefined ? `${root}/${sandboxId}` : trimTrailingSlash(named),
    state: `${stateRoot}/${sandboxId}`,
    owned: named === undefined,
  }
}

/**
 * A caller's path, resolved inside the sandbox's working directory.
 *
 * A leading `/` is read as the *sandbox's* root, not the machine's. Callers of this contract
 * are written against container-absolute paths — `/home/user/repo` on e2b, a workspace root
 * on Cloudflare — and a backend that resolved those against the real filesystem would answer
 * a read of `/etc/passwd` with the host's copy of it, which is neither what the caller means
 * nor something a provider should hand over on a machine it does not own.
 *
 * `..` that climbs past the root throws rather than clamping. Clamping would silently answer
 * a different path than the one asked for, and a caller that has computed its way outside the
 * sandbox has a bug this should name.
 *
 * What this is not: a boundary. It normalises the path it is given; it does not resolve
 * symlinks, so a link inside the sandbox pointing out of it still leads out, and a command
 * running under `exec` is not confined by any of this at all. See the package README — the
 * name says sandbox, the backend is not one.
 */
export function resolveWithin(root: string, path: string): string {
  const base = trimTrailingSlash(root)
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (segments.length === 0) {
        throw new Error(`path '${path}' resolves outside the sandbox root`)
      }
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length === 0 ? base : `${base}/${segments.join('/')}`
}
