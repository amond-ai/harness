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
      cursor: 'lines:1',
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
    expect(result.cursor).toBe('lines:11')
  })

  it('returns only later messages for a cursor but resolves a tool name from before it', () => {
    const head = jsonl(
      user('first'),
      assistant('m1', { type: 'tool_use', id: 't1', name: 'Grep', input: {} }),
    )
    const tail = jsonl(user([{ type: 'tool_result', tool_use_id: 't1', content: 'hit' }]))
    const first = transcriptHistory(head, undefined)

    const next = transcriptHistory(head + tail, first.cursor)

    expect(first.cursor).toBe('lines:2')
    expect(next.cursor).toBe('lines:3')
    expect(next.messages).toMatchObject([
      { role: 'tool', content: [{ toolCallId: 't1', toolName: 'grep' }] },
    ])
  })

  it('neither returns nor counts a trailing line that is still being written', () => {
    const complete = jsonl(user('one'))
    const partial = JSON.stringify(user('two'))

    const result = transcriptHistory(complete + partial, undefined)

    expect(result.messages).toHaveLength(1)
    expect(result.cursor).toBe('lines:1')
    expect(transcriptHistory(`${complete}${partial}\n`, result.cursor).messages).toMatchObject([
      { content: [{ text: 'two' }] },
    ])
  })

  it('answers a cursor beyond the end with no messages and the real end', () => {
    expect(transcriptHistory(jsonl(user('one')), 'lines:9')).toEqual({ messages: [], cursor: 'lines:1' })
    expect(transcriptHistory('', 'lines:1')).toEqual({ messages: [], cursor: 'lines:0' })
  })

  it('throws on a cursor that is not in this format', () => {
    expect(() => transcriptHistory('', 'cursor-7')).toThrow(/cursor-7/)
    expect(() => transcriptHistory('', 'lines:-1')).toThrow(/lines:-1/)
    expect(() => transcriptHistory('', '')).toThrow(/Invalid claude-code history cursor/)
  })
})
