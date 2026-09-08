import { describe, expect, it } from 'vitest'
import { classifyFrame } from './sdk-frames'

describe('classifyFrame', () => {
  it('re-emits a raw frame as one line of the same NDJSON the cli path produces', () => {
    const effect = classifyFrame(JSON.stringify({
      type: 'raw',
      seq: 7,
      rawValue: { type: 'assistant', message: { content: [] } },
    }))

    expect(effect).toEqual({
      kind: 'transcript',
      seq: 7,
      line: `${JSON.stringify({ type: 'assistant', message: { content: [] } })}\n`,
    })
  })

  it('keeps the fields a plain z.object would strip off finish and error', () => {
    // The whole reason `protocol.ts` extends the upstream union: the outcome is read from
    // `stopped` and `phase`, and validating with the vendored schemas deletes both.
    expect(classifyFrame(JSON.stringify({
      type: 'finish',
      seq: 12,
      finishReason: { unified: 'stop', raw: 'stop' },
      totalUsage: { inputTokens: {}, outputTokens: {} },
      stopped: 'interrupted',
      sessionArtifacts: { journalPath: '/state/event-log.ndjson' },
    }))).toEqual({
      kind: 'terminal',
      seq: 12,
      observation: {
        type: 'finish',
        stopped: 'interrupted',
        sessionArtifacts: { journalPath: '/state/event-log.ndjson' },
      },
    })

    expect(classifyFrame(JSON.stringify({ type: 'error', seq: 3, error: 'boom', phase: 'init' })))
      .toEqual({ kind: 'terminal', seq: 3, observation: { type: 'error', phase: 'init', error: 'boom' } })
  })

  it('reads a finish from a host that predates the stopped patch as completed', () => {
    const effect = classifyFrame(JSON.stringify({
      type: 'finish',
      finishReason: { unified: 'stop', raw: 'stop' },
      totalUsage: { inputTokens: {}, outputTokens: {} },
    }))

    expect(effect).toMatchObject({ kind: 'terminal', observation: { type: 'finish', stopped: 'completed' } })
  })

  it('separates the handshake, the host log and liveness from the record', () => {
    expect(classifyFrame(JSON.stringify({ type: 'bridge-hello', state: 'waiting', lastSeq: 4 })))
      .toEqual({ kind: 'hello', state: 'waiting', lastSeq: 4 })
    expect(classifyFrame(JSON.stringify({ type: 'sandbox-log', source: 'claude-code', stream: 'stderr', line: 'x' })))
      .toEqual({ kind: 'log', stream: 'stderr', line: 'x' })
    expect(classifyFrame(JSON.stringify({ type: 'bridge-stop', seq: 9 })))
      .toEqual({ kind: 'liveness', seq: 9 })
  })

  it('reports a frame it cannot read rather than ending the turn on it', () => {
    expect(classifyFrame('{not json')).toMatchObject({ kind: 'unreadable' })
    expect(classifyFrame(JSON.stringify({ type: 'raw' }))).toMatchObject({ kind: 'unreadable' })
  })

  /**
   * `JSON.parse` answers four things that are not objects, and both reads past the schema —
   * `type` and `seq` — assume one. A frame is data from the container: it is reported, never
   * thrown on, or one malformed line would end the round the whole turn is being watched from.
   */
  it('reports a parse that is not an object rather than reading through it', () => {
    expect(classifyFrame('null')).toEqual({ kind: 'unreadable', reason: 'frame is not an object' })
    expect(classifyFrame('[1]')).toEqual({ kind: 'unreadable', reason: 'frame is not an object' })
    expect(classifyFrame('7')).toEqual({ kind: 'unreadable', reason: 'frame is not an object' })
  })
})
