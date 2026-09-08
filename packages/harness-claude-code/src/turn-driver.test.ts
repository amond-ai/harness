import type { SandboxProvider } from '@amond-ai/sandbox'
import type { TurnDriverConfig } from './config'
import { describe, expect, it } from 'vitest'
import { turnDriver } from './turn-driver'

/**
 * The seam itself, from the in-process tier — which is the assertion. `turn-driver.ts` is
 * reachable from `bun test` only while nothing it imports reaches `cloudflare:workers`, and the
 * `sdk` driver's socket opener does: it arrives as a parameter for that reason, and this suite
 * fails to import at all if that ever regresses (`.claude/rules/cf-orchestrator.md`).
 */
const provider = {} as SandboxProvider
const run = {
  sandboxId: 'sandbox-1',
  runId: 'run-1',
  config: {} as TurnDriverConfig,
  openSocket: async () => {
    throw new Error('the cli driver must not dial anything')
  },
  claudeArgv: () => ['claude'] as const,
  settingSources: ['user', 'project'],
}

describe('turnDriver', () => {
  it('builds the incumbent driver, which waits in one step', () => {
    expect(turnDriver(provider, { ...run, kind: 'cli' }).mode).toBe('single')
  })

  it('builds the sdk driver, which waits one bounded attach round at a time', () => {
    expect(turnDriver(provider, { ...run, kind: 'sdk' }).mode).toBe('rounds')
  })
})
