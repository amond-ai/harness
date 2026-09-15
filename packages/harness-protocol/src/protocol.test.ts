import { describe, expect, it } from 'vitest'
import { harnessV1BridgeOutboundMessageSchema } from './harness-v1/harness-v1-bridge-protocol'
import { inboundMessageSchema, startMessageSchema, turnHostOutboundMessageSchema } from './protocol'

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

describe('the turn host\'s outbound union', () => {
  const usage = { inputTokens: {}, outputTokens: {} }
  const finish = {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    totalUsage: usage,
    stopped: 'interrupted',
    sessionArtifacts: { sessionId: 'sess-1', journalPath: '/state/event-log.ndjson' },
  }
  const failed = {
    type: 'error',
    error: 'boom',
    phase: 'run',
    sessionArtifacts: { sessionId: 'sess-1', journalPath: '/state/event-log.ndjson' },
  }

  /*
   * The regression this extension exists for. A plain `z.object` strips undeclared keys, so
   * validating the host's own frames against the upstream union *succeeds* and hands back a
   * `finish` with no `stopped` and an `error` with no `phase` — the fields the attempt outcome
   * is read from. A silent deletion, not a rejection, which is why it needs a test rather than
   * a type.
   */
  it('shows what the upstream union would silently drop', () => {
    const upstreamFinish = harnessV1BridgeOutboundMessageSchema.safeParse(finish)
    expect(upstreamFinish.success).toBe(true)
    expect(upstreamFinish.data).not.toHaveProperty('stopped')
    expect(upstreamFinish.data).not.toHaveProperty('sessionArtifacts')

    const upstreamError = harnessV1BridgeOutboundMessageSchema.safeParse(failed)
    expect(upstreamError.success).toBe(true)
    expect(upstreamError.data).not.toHaveProperty('phase')
    expect(upstreamError.data).not.toHaveProperty('sessionArtifacts')
  })

  it('keeps the fields this host adds to finish and error', () => {
    const parsedFinish = turnHostOutboundMessageSchema.parse(finish)
    expect(parsedFinish).toMatchObject({
      stopped: 'interrupted',
      // The session id rides with the path: a resuming client sends it as `start.resume`
      // rather than parsing it back out of the `<sessionId>.jsonl` filename.
      sessionArtifacts: { sessionId: 'sess-1', journalPath: '/state/event-log.ndjson' },
    })

    // A run-phase error carries the session too: it is the ordinary retry trigger, and the
    // attempt that retries it resumes what this one left.
    expect(turnHostOutboundMessageSchema.parse(failed)).toMatchObject({
      phase: 'run',
      sessionArtifacts: { sessionId: 'sess-1', journalPath: '/state/event-log.ndjson' },
    })
  })

  /*
   * The deferral's own field, on the same footing and for the same reason: `stopped` says a
   * decision is owed, and only this says which request it is owed about — so a client parsing
   * through the upstream union would be told to wait for an answer it cannot ask for.
   */
  it('keeps the deferred call on a deferred finish', () => {
    const deferred = {
      ...finish,
      stopped: 'deferred',
      deferredToolUse: { id: 'call-9', name: 'Bash', input: { command: 'gh pr merge' } },
    }

    expect(harnessV1BridgeOutboundMessageSchema.parse(deferred)).not.toHaveProperty('deferredToolUse')
    expect(turnHostOutboundMessageSchema.parse(deferred)).toMatchObject({
      stopped: 'deferred',
      deferredToolUse: { id: 'call-9', name: 'Bash', input: { command: 'gh pr merge' } },
    })
  })

  /*
   * The interrupt the host acted on, echoed back. The client's own memory of the stop it sent
   * is not durable — it dies with an uncommitted step — so this echo is what a re-entered round
   * reads the cause from, on the `finish` that answered the stop and on the run-phase `error`
   * the host escalated it into.
   */
  it('keeps the interrupt the host answered on finish and on a run-phase error', () => {
    const interrupted = { ...finish, interruptedBy: 'budget' }
    expect(harnessV1BridgeOutboundMessageSchema.parse(interrupted)).not.toHaveProperty('interruptedBy')
    expect(turnHostOutboundMessageSchema.parse(interrupted))
      .toMatchObject({ stopped: 'interrupted', interruptedBy: 'budget' })

    expect(turnHostOutboundMessageSchema.parse({ ...failed, interruptedBy: 'watchdog' }))
      .toMatchObject({ phase: 'run', interruptedBy: 'watchdog' })
  })

  /*
   * A reason outside the enum reads as *no* echo rather than failing the frame.
   *
   * The opposite of the `interrupt` command's contract on purpose, and the asymmetry is the
   * point: inbound, an unknown reason is a client bug and is refused before the turn is touched;
   * outbound, it is a host newer than this client, and rejecting the frame would take `stopped`
   * and `sessionArtifacts` down with a field the client only reads as a hint. An unnamed ending
   * still settles; an unreadable one does not.
   */
  it('degrades an unknown echoed reason to no echo, and accepts an ending that names none', () => {
    const parsed = turnHostOutboundMessageSchema.parse({ ...finish, interruptedBy: 'the-operator' })
    expect(parsed).toMatchObject({ stopped: 'interrupted', sessionArtifacts: { sessionId: 'sess-1' } })
    /*
     * Narrowed on the discriminant rather than indexed straight through. The union's member types
     * are declared, not inferred from the schema — a cast in the substitution would otherwise widen
     * every member to a loose object — so reading a field of one member needs `type` established
     * first. That this narrows at all is the property the declaration exists to keep.
     */
    if (parsed.type !== 'finish') {
      throw new Error(`expected a finish frame, got ${parsed.type}`)
    }
    expect(parsed.interruptedBy).toBeUndefined()

    const failedParsed = turnHostOutboundMessageSchema.parse({ ...failed, interruptedBy: 'the-operator' })
    if (failedParsed.type !== 'error') {
      throw new Error(`expected an error frame, got ${failedParsed.type}`)
    }
    expect(failedParsed.interruptedBy).toBeUndefined()

    expect(turnHostOutboundMessageSchema.parse(finish)).not.toHaveProperty('interruptedBy')
    expect(turnHostOutboundMessageSchema.parse(failed)).not.toHaveProperty('interruptedBy')
  })

  /** Inbound is the strict direction: an unknown reason there is a client bug, and refused. */
  it('still rejects an unknown reason on the interrupt command', () => {
    expect(inboundMessageSchema.safeParse({ type: 'interrupt', reason: 'user' }).success).toBe(false)
  })

  /** The one-shot answers a resumed turn replays; `reason` is the human's own words. */
  it('accepts approved and denied requests on a start', () => {
    expect(startMessageSchema.safeParse({
      type: 'start',
      prompt: 'do the thing',
      resume: 'sess-1',
      approvedRequests: [{ id: 'call-9', name: 'Bash', input: { command: 'ls' } }],
      deniedRequests: [
        { id: 'call-8', name: 'Bash', input: { command: 'rm -rf /' }, reason: 'no' },
      ],
    }).success).toBe(true)
  })

  it('still accepts every frame the upstream union carries', () => {
    for (const frame of [
      { type: 'bridge-hello', state: 'waiting', lastSeq: 0 },
      { type: 'raw', rawValue: { type: 'assistant' } },
      { type: 'sandbox-log', source: 'claude-code', stream: 'stderr', line: 'x' },
    ]) {
      expect(turnHostOutboundMessageSchema.safeParse(frame).success).toBe(true)
    }
  })
})
