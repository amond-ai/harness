/**
 * What reaches a `HarnessAgent` consumer, and what must not.
 *
 * The host's wire is the harness's stream parts *plus* the bridge's control frames and the four
 * fields this deployment hangs off `finish` — so the interesting assertions are the negative
 * ones: a connection frame is not an event, and the host's extensions are not part fields.
 */
import type { TurnHostOutboundMessage } from '@amond-ai/harness-protocol'
import { describe, expect, it } from 'vitest'
import { frameToPart } from './frame-to-part'

const USAGE = {
  inputTokens: { total: 3, noCache: 3, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 2, text: 2, reasoning: 0 },
}

function frame(value: Record<string, unknown>): TurnHostOutboundMessage {
  return value as unknown as TurnHostOutboundMessage
}

describe('one host frame as a stream part', () => {
  it('passes a text delta through, without the sequence the runtime journaled it at', () => {
    const { part } = frameToPart(frame({ type: 'text-delta', id: 't1', delta: 'hello', seq: 7 }))

    expect(part).toEqual({ type: 'text-delta', id: 't1', delta: 'hello' })
  })

  it('emits the host\'s finish with only the harness fields, and keeps the artifacts', () => {
    const translated = frameToPart(frame({
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'end_turn' },
      totalUsage: USAGE,
      seq: 9,
      stopped: 'completed',
      interruptedBy: 'watchdog',
      sessionArtifacts: { sessionId: 'sess-1', sessionTranscriptPath: '/t.jsonl', journalPath: '/j.ndjson' },
    }))

    expect(translated.part).toEqual({
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'end_turn' },
      totalUsage: USAGE,
    })
    // Not emitted, but not lost either: this is the session a later turn resumes by (D8).
    expect(translated.sessionArtifacts).toEqual({
      sessionId: 'sess-1',
      sessionTranscriptPath: '/t.jsonl',
      journalPath: '/j.ndjson',
    })
  })

  it('drops the frames that belong to the connection rather than to the turn', () => {
    const bridge = [
      { type: 'bridge-hello', state: 'waiting', lastSeq: 0 },
      { type: 'bridge-ready', port: 41_001 },
      { type: 'bridge-started', seq: 1 },
      { type: 'sandbox-log', stream: 'stderr', line: 'booting' },
    ]

    expect(bridge.map(value => frameToPart(frame(value)))).toEqual([{}, {}, {}, {}])
  })

  it('drops a frame no stream part shape accepts rather than forwarding it raw', () => {
    expect(frameToPart(frame({ type: 'text-delta', id: 't1' }))).toEqual({})
  })

  it('keeps how a non-completed finish ended, which the strip would otherwise erase', () => {
    // The host hardcodes `finishReason: 'stop'` on every ending, so once `stopped` is stripped an
    // interrupted finish is byte-identical to a completed one. This is the only thing that tells
    // them apart.
    const interrupted = frameToPart(frame({
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      totalUsage: USAGE,
      stopped: 'interrupted',
      interruptedBy: 'watchdog',
    }))

    expect(interrupted.ending).toEqual({ reason: 'interrupted', interruptedBy: 'watchdog' })

    const deferred = frameToPart(frame({
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      totalUsage: USAGE,
      stopped: 'deferred',
      deferredToolUse: { id: 'call-9', name: 'Bash', input: { command: 'gh pr merge' } },
    }))

    // The id the approval flow keys on: stripped from the part, so it has to survive here or the
    // pending request is unrecoverable from the stream.
    expect(deferred.ending).toEqual({
      reason: 'deferred',
      deferredToolUse: { id: 'call-9', name: 'Bash', input: { command: 'gh pr merge' } },
    })

    // A completion still reports itself as one, and a non-finish frame names no ending at all.
    expect(frameToPart(frame({ type: 'text-delta', id: 't1', delta: 'x' })).ending).toBeUndefined()
  })
})
