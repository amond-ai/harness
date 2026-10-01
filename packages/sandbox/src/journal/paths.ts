/**
 * The process journal's layout — where one process's artefacts live and what is remembered
 * about it once the sandbox's own process table no longer will.
 *
 * Runtime-neutral: the files are plain paths under a root the backend chooses, so a backend
 * that reads them over `exec` and one that reads them through an SDK share the same layout.
 */
import type { SandboxCommand } from '../types'

/**
 * The suffix a process's stdout file carries.
 *
 * Exported because the wrapper's own command line is what identifies a process when its meta
 * file is gone: `e2b-session.ts` reads the id back out of the redirection, and a suffix that
 * drifted from {@link journalPaths} would silently stop recovering anything.
 */
export const STDOUT_SUFFIX = '.out'

export interface JournalPaths {
  stdout: string
  stderr: string
  exit: string
  meta: string
}

/**
 * Where one process's artefacts live.
 *
 * The id is validated rather than escaped: it is interpolated into a filesystem path, and
 * the ids this backend mints are opaque tokens, so anything outside `[A-Za-z0-9_-]` means
 * a caller passed something it should not have — including the `../` that would write
 * outside the journal root.
 */
export function journalPaths(root: string, processId: string): JournalPaths {
  if (!isProcessId(processId)) {
    throw new Error(`invalid process id '${processId}': expected [A-Za-z0-9_-]+`)
  }
  const base = root.replace(/\/+$/, '')
  return {
    stdout: `${base}/${processId}${STDOUT_SUFFIX}`,
    stderr: `${base}/${processId}.err`,
    exit: `${base}/${processId}.exit`,
    meta: `${base}/${processId}.meta.json`,
  }
}

/**
 * Does this string name a process the way {@link journalPaths} demands?
 *
 * Exported so `listProcesses` can *skip* a filename it would reject rather than let
 * `journalPaths` throw mid-listing: the journal root is an ordinary directory, and one
 * unrelated file dropped in it (`2026-08-24.log`) would otherwise take out process
 * discovery for that sandbox entirely — inside a never-retried workflow step.
 */
export function isProcessId(value: string): boolean {
  return /^[\w-]+$/.test(value)
}

/** What the backend must remember about a process once e2b no longer will. */
export interface JournalMeta {
  id: string
  /** e2b's pid, captured host-side after `commands.run` — the key for `kill` and liveness. */
  pid: number
  /** Non-empty by construction: a meta recording no command records nothing that ran. */
  command: SandboxCommand
  cwd?: string
  startedAt: string
}

export function serializeJournalMeta(meta: JournalMeta): string {
  return JSON.stringify(meta)
}

/**
 * Read a meta record back, or `undefined` when the file is absent, truncated or not one.
 *
 * A missing journal is a normal state — the process may not have started — so this reports
 * absence rather than throwing, and the caller decides whether absence is a failure.
 */
export function parseJournalMeta(raw: string): JournalMeta | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return undefined
  }
  const candidate = parsed as Partial<JournalMeta>
  // The elements are checked, not just the array: `command` is a `SandboxCommand`, and a
  // journal file is untrusted input — it lives in the sandbox the agent itself writes to.
  // `["claude", 5]` would otherwise pass the cast and violate the tuple's own invariant.
  if (typeof candidate.id !== 'string' || typeof candidate.pid !== 'number'
    || !Array.isArray(candidate.command) || candidate.command.length === 0
    || !candidate.command.every(element => typeof element === 'string')
    || (candidate.cwd !== undefined && typeof candidate.cwd !== 'string')
    || typeof candidate.startedAt !== 'string') {
    return undefined
  }
  return candidate as JournalMeta
}
