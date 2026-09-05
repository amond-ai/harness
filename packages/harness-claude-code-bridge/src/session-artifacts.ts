/*
 * Where a turn's two durable artifacts live. The Worker never reconstructs
 * these paths: the `<encoded-cwd>` rule is a CLI implementation detail, and the
 * host is the process pinned to the same CLI patch as the SDK it runs, so the
 * coupling lives where the versions are asserted together.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export interface SessionArtifacts {
  /** The CLI's session jsonl — the resume record. */
  sessionTranscriptPath: string
  /** `<bridgeStateDir>/event-log.ndjson` — the observation record. */
  journalPath: string
}

/**
 * The CLI's project-directory encoding: every character outside `[A-Za-z0-9]`
 * becomes `-`.
 *
 * Verified against the SDK bundle (`sdk.mjs` carries
 * `replace(/[^a-zA-Z0-9]/g, "-")`) and against real directories under
 * `~/.claude/projects/`: `/Volumes/Dev/IdeaProjects/posttalks/.claude/worktrees/basin-starlight`
 * is stored as `-Volumes-Dev-IdeaProjects-posttalks--claude-worktrees-basin-starlight`,
 * so the `/.` pair became `--` and the dot is not preserved. (Directories
 * written before ~2026-03 do keep dots; that CLI used a different rule.)
 *
 * Known limit: past 200 characters the CLI truncates and appends a base36 hash
 * of the full path, which is not reproduced here — the hash function is not
 * exported. Sandbox checkout paths are far shorter.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-z0-9]/gi, '-')
}

/** `CLAUDE_CONFIG_DIR` when set, else `~/.claude`. */
export function claudeConfigDir(env: NodeJS.ProcessEnv): string {
  return env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
}

export function sessionTranscriptPath(input: {
  cwd: string
  sessionId: string
  env: NodeJS.ProcessEnv
}): string {
  return join(
    claudeConfigDir(input.env),
    'projects',
    encodeProjectDir(input.cwd),
    `${input.sessionId}.jsonl`,
  )
}

/** How the turn ended, as the Worker judges it. */
export type StoppedReason = 'completed' | 'interrupted' | 'deferred'

/**
 * Map the SDK's `terminal_reason` onto the three outcomes the Workflow acts
 * on. `interrupted` and `deferred` are not `TerminalReason` members, which is
 * why this mapping exists rather than a passthrough.
 */
export function stoppedFromTerminalReason(
  terminalReason: string | undefined,
): StoppedReason {
  switch (terminalReason) {
    case 'aborted_streaming':
    case 'aborted_tools':
      return 'interrupted'
    case 'tool_deferred':
      return 'deferred'
    default:
      return 'completed'
  }
}
