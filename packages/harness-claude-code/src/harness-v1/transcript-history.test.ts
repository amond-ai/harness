/**
 * The transcript reader is pure text in, messages out, so these tests feed it the lines the CLI
 * writes and check each rule on its own: what counts as conversation, how one API message split
 * across lines is put back together, and how the line-count cursor behaves at its edges.
 */
import { describe, expect, it } from 'vitest'
import { transcriptHistory } from './transcript-history'

const jsonl = (...lines: unknown[]): string => lines.map(line => `${JSON.stringify(line)}\n`).join('')

function user(content: unknown, extra: object = {}): object {
  return { type: 'user', uuid: 'u', timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content }, ...extra }
}

function assistant(id: string, block: object, timestamp = '2026-01-01T00:00:01.000Z'): object {
  return { type: 'assistant', uuid: 'a', timestamp, message: { role: 'assistant', id, content: [block] } }
}

describe('transcriptHistory', () => {
  it('reads a user string line as one text message with its timestamp', () => {
    const result = transcriptHistory(jsonl(user('hello there')), undefined)

    expect(result).toEqual({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hello there' }], at: '2026-01-01T00:00:00.000Z' }],
      cursor: 'lines:1:u',
    })
  })

  it('merges consecutive assistant lines of one API message and names tools like the live stream', () => {
    const text = jsonl(
      assistant('m1', { type: 'thinking', thinking: 'hmm' }, '2026-01-01T00:00:01.000Z'),
      assistant('m1', { type: 'text', text: 'looking' }),
      assistant('m1', { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }),
      assistant('m1', { type: 'tool_use', id: 't2', name: 'mcp__x__y', input: { a: 1 } }),
      assistant('m1', { type: 'redacted_thinking', data: 'x' }),
      assistant('m2', { type: 'text', text: 'done' }),
    )

    expect(transcriptHistory(text, undefined).messages).toEqual([
      {
        role: 'assistant',
        at: '2026-01-01T00:00:01.000Z',
        content: [
          { type: 'reasoning', text: 'hmm' },
          { type: 'text', text: 'looking' },
          { type: 'tool-call', toolCallId: 't1', toolName: 'bash', nativeName: 'Bash', input: { command: 'ls' }, providerExecuted: true },
          { type: 'tool-call', toolCallId: 't2', toolName: 'mcp__x__y', nativeName: 'mcp__x__y', input: { a: 1 }, providerExecuted: true },
        ],
      },
      { role: 'assistant', at: '2026-01-01T00:00:01.000Z', content: [{ type: 'text', text: 'done' }] },
    ])
  })

  it('turns tool_result blocks into tool messages with the resolved name, errors as error-text', () => {
    const text = jsonl(
      assistant('m1', { type: 'tool_use', id: 't1', name: 'Read', input: {} }),
      user([
        { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }] },
        { type: 'tool_result', tool_use_id: 't1', content: 'boom', is_error: true },
        { type: 'tool_result', tool_use_id: 'nope', content: 'x' },
        { type: 'text', text: 'and then' },
      ]),
    )

    const [, tool, followUp] = transcriptHistory(text, undefined).messages

    expect(tool).toMatchObject({
      role: 'tool',
      content: [
        { type: 'tool-result', toolCallId: 't1', toolName: 'read', output: { type: 'text', value: 'a\nb' } },
        { type: 'tool-result', toolCallId: 't1', toolName: 'read', output: { type: 'error-text', value: 'boom' } },
        { type: 'tool-result', toolCallId: 'nope', toolName: 'unknown', output: { type: 'text', value: 'x' } },
      ],
    })
    expect(followUp).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'and then' }] })
  })

  it('reads a base64 image block as a file part', () => {
    const block = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }

    expect(transcriptHistory(jsonl(user([block, { type: 'document' }])), undefined).messages).toMatchObject([
      { role: 'user', content: [{ type: 'file', mediaType: 'image/png', data: { type: 'data', data: 'QUJD' } }] },
    ])
  })

  it('skips sidechain, meta, compact-summary, team, non-conversation and corrupt lines but still counts them', () => {
    const text = [
      JSON.stringify(user('kept')),
      JSON.stringify(user('sub', { isSidechain: true })),
      JSON.stringify(user('meta', { isMeta: true })),
      JSON.stringify(user('summary', { isCompactSummary: true })),
      JSON.stringify(user('team', { teamName: 'crew' })),
      JSON.stringify({ type: 'summary', summary: 's' }),
      JSON.stringify({ type: 'system', content: 'c' }),
      JSON.stringify({ type: 'progress' }),
      '{not json',
      '[1,2]',
      JSON.stringify(user([{ type: 'tool_result', tool_use_id: 'x' }, { type: 'unknown' }])),
      '',
    ].join('\n')

    const result = transcriptHistory(text, undefined)

    expect(result.messages).toMatchObject([
      { role: 'user', content: [{ text: 'kept' }] },
      { role: 'tool', content: [{ toolName: 'unknown', output: { type: 'text', value: '' } }] },
    ])
    expect(result.cursor).toBe('lines:11:u')
  })

  it('returns only later messages for a cursor but resolves a tool name from before it', () => {
    const head = jsonl(
      user('first'),
      assistant('m1', { type: 'tool_use', id: 't1', name: 'Grep', input: {} }),
    )
    const tail = jsonl(user([{ type: 'tool_result', tool_use_id: 't1', content: 'hit' }]))
    const first = transcriptHistory(head, undefined)

    const next = transcriptHistory(head + tail, first.cursor)

    expect(first.cursor).toBe('lines:2:a')
    expect(next.cursor).toBe('lines:3:u')
    expect(next.messages).toMatchObject([
      { role: 'tool', content: [{ toolCallId: 't1', toolName: 'grep' }] },
    ])
  })

  it('neither returns nor counts a trailing line that is still being written', () => {
    const complete = jsonl(user('one'))
    const partial = JSON.stringify(user('two'))

    const result = transcriptHistory(complete + partial, undefined)

    expect(result.messages).toHaveLength(1)
    expect(result.cursor).toBe('lines:1:u')
    expect(transcriptHistory(`${complete}${partial}\n`, result.cursor).messages).toMatchObject([
      { content: [{ text: 'two' }] },
    ])
  })

  it('answers a cursor beyond the end with no messages and the real end', () => {
    expect(transcriptHistory(jsonl(user('one')), 'lines:9')).toEqual({ messages: [], cursor: 'lines:1:u' })
    expect(transcriptHistory('', 'lines:1')).toEqual({ messages: [], cursor: 'lines:0' })
  })

  it('detects a replaced transcript that grew past the old cursor by its fingerprint', () => {
    const before = jsonl(user('one', { uuid: 'old-1' }), user('two', { uuid: 'old-2' }))
    const { cursor } = transcriptHistory(before, undefined)
    const replaced = jsonl(user('x', { uuid: 'new-1' }), user('y', { uuid: 'new-2' }), user('z', { uuid: 'new-3' }))

    expect(cursor).toBe('lines:2:old-2')
    expect(transcriptHistory(replaced, cursor)).toEqual({ messages: [], cursor: 'lines:3:new-3' })
    expect(transcriptHistory(before + jsonl(user('three', { uuid: 'old-3' })), cursor).messages).toMatchObject([
      { content: [{ text: 'three' }] },
    ])
  })

  it('fingerprints the last counted line that has a uuid, past trailing metadata lines', () => {
    const original = jsonl(user('one', { uuid: 'old-1' }), user('two', { uuid: 'old-2' }), { type: 'last-prompt' })
    const { cursor } = transcriptHistory(original, undefined)
    const replaced = jsonl(
      user('a', { uuid: 'new-1' }),
      user('b', { uuid: 'new-2' }),
      user('c', { uuid: 'new-3' }),
      user('d', { uuid: 'new-4' }),
    )

    expect(cursor).toBe('lines:3:old-2')
    expect(transcriptHistory(replaced, cursor)).toEqual({ messages: [], cursor: 'lines:4:new-4' })
    expect(transcriptHistory(original + jsonl(user('three', { uuid: 'old-3' })), cursor).messages).toMatchObject([
      { content: [{ text: 'three' }] },
    ])
  })

  it('accepts a cursor without a fingerprint and omits one when no counted line has a uuid', () => {
    const text = jsonl({ type: 'user', message: { content: 'first' } }, { type: 'user', message: { content: 'no uuid' } })

    expect(transcriptHistory(text, 'lines:1').messages).toMatchObject([{ content: [{ text: 'no uuid' }] }])
    expect(transcriptHistory(text, undefined).cursor).toBe('lines:2')
  })

  it('throws on a cursor that is not in this format', () => {
    expect(() => transcriptHistory('', 'cursor-7')).toThrow(/cursor-7/)
    expect(() => transcriptHistory('', 'lines:-1')).toThrow(/lines:-1/)
    expect(() => transcriptHistory('', 'lines:1:')).toThrow(/lines:1:/)
    expect(() => transcriptHistory('', 'lines:1:a:b')).toThrow(/lines:1:a:b/)
    expect(() => transcriptHistory('', '')).toThrow(/Invalid claude-code history cursor/)
  })
})
