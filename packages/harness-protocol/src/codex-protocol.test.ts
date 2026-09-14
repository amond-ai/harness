import { describe, expect, it } from 'vitest'
import {
  codexTurnHostFinishSchema,
  codexTurnHostOutboundMessageSchema,
  inboundMessageSchema,
  startMessageSchema,
} from './codex-protocol'
import { harnessV1BridgeOutboundMessageSchema } from './harness-v1/harness-v1-bridge-protocol'

describe('the codex bridge\'s start schema', () => {
  /*
   * Every field upstream's adapter can put on a `start`, at once. The interesting half is not
   * that `safeParse` succeeds — it is that `data` still holds all of them: the base schema this
   * extends is a plain `z.object`, so a field the extension forgot to declare would be dropped
   * here with no error, and a bridge would read `undefined` for a value the client sent.
   */
  const start = {
    type: 'start',
    prompt: 'do the thing',
    model: 'gpt-5-codex',
    instructions: 'be terse',
    reasoningEffort: 'xhigh',
    webSearch: true,
    codexConfig: { sandbox: 'workspace-write' },
    mcpServers: { gh: { command: 'x' } },
    headers: { 'x-a': 'b' },
    resumeThreadId: 'thr_1',
    restartThread: false,
    debug: { enabled: true, level: 'debug' },
    permissionMode: 'allow-all',
    responseFormat: { type: 'json', schema: {} },
  }

  it('keeps every field a codex start carries', () => {
    const parsed = startMessageSchema.safeParse(start)
    expect(parsed.success).toBe(true)
    expect(parsed.data).toMatchObject(start)
    expect(Object.keys(parsed.data ?? {}).sort()).toEqual(Object.keys(start).sort())
  })

  it('accepts a start carrying nothing but a prompt', () => {
    expect(startMessageSchema.safeParse({ type: 'start', prompt: 'go' }).success).toBe(true)
  })

  /*
   * The runtime routes `interrupt` to the turn's handler, so a codex bridge speaks it whether or
   * not its adapter added anything — and it validates the reason against its own hardcoded list.
   * The schema has to agree on both halves: the three reasons, and nothing else.
   */
  it('accepts the interrupt command and refuses a reason outside the enum', () => {
    for (const reason of ['watchdog', 'budget', 'operator']) {
      expect(inboundMessageSchema.safeParse({ type: 'interrupt', reason }).success).toBe(true)
    }
    expect(inboundMessageSchema.safeParse({ type: 'interrupt', reason: 'whenever' }).success).toBe(false)
  })
})

describe('the codex bridge\'s outbound union', () => {
  const usage = { inputTokens: {}, outputTokens: {} }
  const finish = {
    type: 'finish',
    finishReason: { unified: 'stop', raw: 'stop' },
    totalUsage: usage,
    stopped: 'interrupted',
    interruptedBy: 'budget',
    journalPath: '/state/event-log.ndjson',
  }
  const failed = {
    type: 'error',
    error: 'boom',
    phase: 'run',
    journalPath: '/state/event-log.ndjson',
  }

  /*
   * The regression this extension exists for, in Codex's shape. A plain `z.object` strips
   * undeclared keys, so validating the bridge's own frames against the upstream union *succeeds*
   * and hands back a `finish` with no `stopped` — and since the bridge hardcodes `finishReason`
   * to `stop` on every ending, that frame is then indistinguishable from a completed turn.
   */
  it('shows what the upstream union would silently drop', () => {
    const upstreamFinish = harnessV1BridgeOutboundMessageSchema.safeParse(finish)
    expect(upstreamFinish.success).toBe(true)
    expect(upstreamFinish.data).not.toHaveProperty('stopped')
    expect(upstreamFinish.data).not.toHaveProperty('interruptedBy')
    expect(upstreamFinish.data).not.toHaveProperty('journalPath')

    const upstreamError = harnessV1BridgeOutboundMessageSchema.safeParse(failed)
    expect(upstreamError.success).toBe(true)
    expect(upstreamError.data).not.toHaveProperty('phase')
    expect(upstreamError.data).not.toHaveProperty('journalPath')
  })

  it('keeps the fields a codex bridge adds to finish and error', () => {
    expect(codexTurnHostOutboundMessageSchema.parse(finish)).toMatchObject({
      stopped: 'interrupted',
      interruptedBy: 'budget',
      journalPath: '/state/event-log.ndjson',
    })
    expect(codexTurnHostOutboundMessageSchema.parse(failed)).toMatchObject({
      phase: 'run',
      journalPath: '/state/event-log.ndjson',
    })
  })

  /*
   * `bridge-thread` carries the thread id a later turn resumes by, which is the whole of Codex's
   * resume story — it reaches this union through the upstream filter rather than by being named,
   * so nothing else would notice if upstream moved it. `bridge-started` is this deployment's own
   * and is added explicitly.
   */
  it('accepts the resume coordinate and the start acknowledgement', () => {
    expect(codexTurnHostOutboundMessageSchema.safeParse({
      type: 'bridge-thread',
      threadId: 'thr_1',
    }).success).toBe(true)
    expect(codexTurnHostOutboundMessageSchema.safeParse({ type: 'bridge-started' }).success).toBe(true)
  })

  /*
   * A host newer than this client can name a fourth interrupt reason. Refusing the whole frame
   * over a field the client only reads as a hint would cost it `stopped` too, so the unknown
   * value degrades to "no echo" instead.
   */
  it('degrades an unknown interruptedBy rather than failing the frame', () => {
    const parsed = codexTurnHostFinishSchema.safeParse({ ...finish, interruptedBy: 'eclipse' })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.interruptedBy).toBeUndefined()
    expect(parsed.data?.stopped).toBe('interrupted')
  })

  /*
   * Codex runs under a never-ask approval policy, so a turn cannot park on a decision. The field
   * Claude's `finish` carries for that has no counterpart here, and a frame that sent one anyway
   * is stripped rather than accepted — which is the honest reading: this bridge has no deferral.
   */
  it('carries no deferredToolUse', () => {
    const parsed = codexTurnHostFinishSchema.parse({
      ...finish,
      deferredToolUse: { id: 't1', name: 'Bash', input: {} },
    })
    expect(parsed).not.toHaveProperty('deferredToolUse')
  })
})
