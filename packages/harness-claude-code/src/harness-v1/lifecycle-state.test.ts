/**
 * The adapter's promise about its own state: what it hands back can be handed in again.
 *
 * `lifecycleStateSchema` is that promise as the harness contract states it, so it is asserted on
 * both payload shapes — the mid-turn one and the between-turns one — and on the refusal that
 * keeps another adapter's state out of a container this one provisioned.
 */
import { describe, expect, it } from 'vitest'
import { createClaudeCode } from './create-claude-code'
import { claudeCodeLifecycleStateSchema } from './lifecycle-state'

const CONFIG = {
  watchdogTimeoutMs: 10_000,
  livenessWindowMs: 1_000,
  livenessSampleIntervalMs: 5,
  turnWallClockBudgetMs: 60_000,
  turnDeferTools: [],
  turnRefuseTools: [],
  workspaceRoot: '/workspace',
}

const SANDBOX_SESSION = { id: 'sbx-1', defaultWorkingDirectory: '/workspace' } as never

function adapter() {
  return createClaudeCode({
    sandboxes: {} as never,
    openSocket: async () => {
      throw new Error('no socket in this test')
    },
    config: CONFIG,
    settingSources: ['project'],
    env: () => ({}),
  })
}

describe('the claude-code lifecycle state', () => {
  it('round-trips a suspended turn: the handle, the cursor and the round it stopped at', () => {
    const data = {
      sandboxId: 'sbx-1',
      handle: { processId: 'host-1', startedAtMs: 1, port: 41_001, token: 'tok', bridgeStateDir: '/s' },
      round: { since: 12, lastActivityAt: 2, round: 3 },
      attempt: 1,
    }

    expect(claudeCodeLifecycleStateSchema.parse(data)).toEqual(data)
  })

  it('round-trips a parked session: the artifacts, and no turn to attach to', () => {
    const data = {
      sandboxId: 'sbx-1',
      session: { sessionId: 'sess-1', transcriptPath: '/t.jsonl', journalPath: '/j.ndjson' },
      attempt: 2,
    }

    expect(claudeCodeLifecycleStateSchema.parse(data)).toEqual(data)
  })

  it('refuses a state another harness wrote, whatever its payload looks like', async () => {
    await expect(adapter().doStart({
      sessionId: 's1',
      sessionWorkDir: '/workspace/claude-code-s1',
      sandboxSession: SANDBOX_SESSION,
      resumeFrom: {
        type: 'resume-session',
        harnessId: 'codex',
        specificationVersion: 'harness-v1',
        data: { sandboxId: 'sbx-1', attempt: 1 },
      },
    })).rejects.toThrow(/'codex'.*'claude-code'/)
  })
})
