import { describe, expect, it } from 'vitest'
import { inboundMessageSchema, startMessageSchema } from './protocol'

describe('the turn host\'s start schema', () => {
  it('accepts a start carrying nothing but a prompt', () => {
    // Upstream declares `thinking` without `.optional()`; the extension makes it
    // optional, and a start without it is the common case.
    expect(startMessageSchema.safeParse({
      type: 'start',
      prompt: 'do the thing',
    }).success).toBe(true)
  })

  it('accepts both the harness permission modes and the SDK ones', () => {
    // Every member of the SDK's own `PermissionMode` union, because the Worker
    // offers all of them (`PERMISSION_MODES` in `apps/cf-orchestrator/src/env.ts`)
    // and a mode it can configure but the schema refuses fails the turn at `start`.
    for (const permissionMode of [
      'allow-reads',
      'default',
      'acceptEdits',
      'bypassPermissions',
      'plan',
      'dontAsk',
      'auto',
    ]) {
      expect(startMessageSchema.safeParse({
        type: 'start',
        prompt: 'do the thing',
        permissionMode,
      }).success).toBe(true)
    }
  })
})

describe('the inbound union', () => {
  it('carries the shared commands and this host\'s interrupt', () => {
    for (const message of [
      { type: 'resume', lastSeenEventId: 4 },
      { type: 'interrupt', reason: 'watchdog' },
    ]) {
      expect(inboundMessageSchema.safeParse(message).success).toBe(true)
    }
    expect(inboundMessageSchema.safeParse({
      type: 'interrupt',
      reason: 'whenever',
    }).success).toBe(false)
  })
})
