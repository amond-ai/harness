import type { WebSocket } from 'ws'
import type { Host } from './harness'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { WebSocketServer } from 'ws'
import {
  connect,
  createFakeQuery,
  initMessage,
  resultMessage,
  startHost,
  streamEventMessages,
} from './harness'

let host: Host | undefined

afterEach(async () => {
  await host?.close()
  host = undefined
})

it('emits every non-stream_event SDK message as a journaled raw frame', async () => {
  const query = createFakeQuery([
    initMessage(),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const raws = client.frames.filter(frame => frame.type === 'raw')
  expect(raws.map(frame => (frame.rawValue as { type: string }).type)).toEqual([
    'system',
    'assistant',
    'result',
  ])
  expect(raws.every(frame => typeof frame.seq === 'number')).toBe(true)

  // The journal already held each raw frame when the socket received it.
  const journal = await host.readJournal()
  expect(journal.filter(frame => frame.type === 'raw')).toHaveLength(3)
})

it('forwards task, progress and subagent messages raw exactly once, and maps none of them', async () => {
  const script = [
    initMessage(),
    { type: 'system', subtype: 'task_started', task_id: 'task-1' },
    { type: 'tool_progress', tool_use_id: 'toolu_task_1', elapsed_time_seconds: 3 },
    {
      type: 'assistant',
      parent_tool_use_id: 'toolu_task_1',
      message: { content: [{ type: 'tool_use', id: 'toolu_sub_1', name: 'Bash', input: { command: 'ls' } }] },
    },
    // A subagent's token delta: raw, as upstream forwards it, but not a part.
    {
      type: 'stream_event',
      parent_tool_use_id: 'toolu_task_1',
      event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
    },
    { type: 'system', subtype: 'task_notification', task_id: 'task-1', status: 'completed' },
    resultMessage(),
  ]
  const query = createFakeQuery(script)
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const raws = client.frames.filter(frame => frame.type === 'raw').map(frame => frame.rawValue)
  expect(raws).toEqual(script)
  expect(client.frames.some(frame => frame.type === 'tool-call' || frame.type === 'text-start')).toBe(false)
  client.close()
})

it('journals a subagent stream_event as one raw, and keeps the parent\'s own stream_event out of raw', async () => {
  const subagentDelta = {
    type: 'stream_event',
    parent_tool_use_id: 'toolu_task_1',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub' } },
  }
  const query = createFakeQuery([
    initMessage(),
    subagentDelta,
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } },
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const isStreamRaw = (frame: Record<string, unknown>): boolean =>
    frame.type === 'raw' && (frame.rawValue as { type?: string }).type === 'stream_event'
  const live = client.frames.filter(isStreamRaw)
  expect(live.map(frame => frame.rawValue)).toEqual([subagentDelta])
  // Not live-only: the journal holds the same line the live mirror appended.
  expect((await host.readJournal()).filter(isStreamRaw)).toEqual(live)
  client.close()
})

it('acknowledges a start before the query has said anything', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const types = client.frames.map(frame => frame.type)
  expect(types.indexOf('bridge-started')).toBeGreaterThan(types.indexOf('bridge-hello'))
  expect(types.indexOf('bridge-started')).toBeLessThan(types.indexOf('raw'))
  expect(client.frames.find(frame => frame.type === 'bridge-started')?.seq).toEqual(expect.any(Number))
  expect((await host.readJournal()).some(frame => frame.type === 'bridge-started')).toBe(true)
})

it('keeps stream_event-derived frames out of the journal and out of a replay', async () => {
  const query = createFakeQuery([
    initMessage(),
    ...streamEventMessages(),
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  expect(client.frames.some(frame => frame.type === 'text-delta')).toBe(true)

  const journal = await host.readJournal()
  expect(journal.some(frame => frame.type === 'text-delta')).toBe(false)
  expect(journal.some(frame => frame.type === 'text-start')).toBe(false)

  const replayed = await connect(host)
  replayed.send({ type: 'resume', lastSeenEventId: 0 })
  await replayed.waitFor(frame => frame.type === 'finish')
  expect(replayed.frames.some(frame => frame.type === 'raw')).toBe(true)
  expect(replayed.frames.some(frame => frame.type === 'text-delta')).toBe(false)
  replayed.close()
  client.close()
})

it('streams a tool call\'s input as live-only tool-input parts', async () => {
  const toolUse = (index: number, id: string, name: string): Array<Record<string, unknown>> => [
    { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', id, name } } },
    { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: '{"a":1}' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index } },
  ]
  const query = createFakeQuery([
    initMessage(),
    ...toolUse(0, 'toolu_1', 'Bash'),
    ...toolUse(1, 'toolu_2', 'mcp__github__create_issue'),
    // The structured answer is not a tool the agent called, so it streams nothing.
    ...toolUse(2, 'toolu_3', 'StructuredOutput'),
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const inputs = client.frames
    .filter(frame => frame.type.startsWith('tool-input-'))
    .map(({ seq: _seq, ...frame }) => frame)
  expect(inputs).toEqual([
    { type: 'tool-input-start', id: 'toolu_1', toolName: 'bash', providerExecuted: true },
    { type: 'tool-input-delta', id: 'toolu_1', delta: '{"a":1}' },
    { type: 'tool-input-end', id: 'toolu_1' },
    { type: 'tool-input-start', id: 'toolu_2', toolName: 'mcp__github__create_issue', providerExecuted: true, dynamic: true },
    { type: 'tool-input-delta', id: 'toolu_2', delta: '{"a":1}' },
    { type: 'tool-input-end', id: 'toolu_2' },
  ])
  // Liveness, like the text deltas: the record of the call is its `assistant` message.
  expect((await host.readJournal()).some(frame => frame.type.startsWith('tool-input-'))).toBe(false)
  client.close()
})

it('journals a message_stop raw carrying the response\'s summed usage', async () => {
  const query = createFakeQuery([
    initMessage(),
    { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 7 } } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50, input_tokens: null } } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const isStop = (frame: Record<string, unknown>): boolean =>
    frame.type === 'raw' && (frame.rawValue as { event?: { type?: string } }).event?.type === 'message_stop'
  const live = client.frames.filter(isStop)
  expect(live.map(frame => frame.rawValue)).toEqual([{
    type: 'stream_event',
    event: { type: 'message_stop' },
    // A later delta wins, and a null one does not erase what `message_start` reported.
    usage: { input_tokens: 10, output_tokens: 50 },
  }])
  // Not live-only: the journal, and so the transcript a settle rebuilds from it, holds the same
  // line the live mirror appended — and only that one of the four `stream_event`s.
  const journaled = (await host.readJournal()).filter(isStop)
  expect(journaled).toEqual(live)
  expect((await host.readJournal()).filter(frame => frame.type === 'raw')).toHaveLength(3)
  client.close()
})

it('meters a step from the usage the response streamed after the assistant message', async () => {
  const query = createFakeQuery([
    initMessage(),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 50 } } },
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const step = await client.waitFor(frame => frame.type === 'finish-step')

  // The assistant message reports the usage at its first token; the delta carries the rest.
  expect(step.usage).toMatchObject({
    inputTokens: { total: 10, noCache: 10 },
    outputTokens: { total: 50 },
  })
  client.close()
})

it('does not let a streamed usage that reports 0 input tokens erase the complete count', async () => {
  const query = createFakeQuery([
    initMessage(),
    { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { input_tokens: 0, output_tokens: 50 } } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const step = await client.waitFor(frame => frame.type === 'finish-step')

  expect(step.usage).toMatchObject({
    inputTokens: { total: 10, noCache: 10 },
    outputTokens: { total: 50 },
  })
  const stop = client.frames.find(frame => frame.type === 'raw' && (frame.rawValue as { event?: { type?: string } }).event?.type === 'message_stop')
  expect((stop?.rawValue as { usage: unknown }).usage).toEqual({ input_tokens: 10, output_tokens: 50 })
  client.close()
})

it('closes a tool step at the response\'s message_stop, journaled, when its result arrived mid-response', async () => {
  const query = createFakeQuery([
    initMessage(),
    { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } } },
    {
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'ls' } }],
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    // The CLI ran the tool before the response that called it finished streaming.
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' }] } },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } },
    { type: 'stream_event', event: { type: 'message_stop' } },
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  const steps = client.frames.filter(frame => frame.type === 'finish-step')
  expect(steps).toHaveLength(1)
  const stop = client.frames.findIndex(frame => frame.type === 'raw'
    && (frame.rawValue as { event?: { type?: string } }).event?.type === 'message_stop')
  expect(client.frames.indexOf(steps[0]!)).toBeGreaterThan(stop)
  // Closed once the response's whole usage was in, not at the tool result.
  expect(steps[0]!.usage).toMatchObject({ outputTokens: { total: 40 } })

  // Built from a `stream_event`, yet structure: the journal, and the transcript a client
  // rebuilds by replaying it, hold the same `finish-step` the live socket saw.
  expect((await host.readJournal()).filter(frame => frame.type === 'finish-step')).toEqual(steps)
  const replayed = await connect(host)
  replayed.send({ type: 'resume', lastSeenEventId: 0 })
  await replayed.waitFor(frame => frame.type === 'finish' && frame.seq === finish.seq)
  expect(replayed.frames.filter(frame => frame.type === 'finish-step')).toEqual(steps)
  replayed.close()
  client.close()
})

it('pauses a response\'s parallel approvals on the host with one journaled finish-step, ahead of the step\'s own', async () => {
  const pwd = { command: 'pwd' }
  const query = createFakeQuery([
    initMessage(),
    { type: 'stream_event', event: { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } } },
    {
      type: 'assistant',
      message: {
        content: ['first', 'second'].map(id => ({ type: 'tool_use', id, name: 'Bash', input: pwd })),
        usage: { input_tokens: 10, output_tokens: 1 },
      },
    },
    { type: 'stream_event', event: { type: 'message_delta', usage: { output_tokens: 40 } } },
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing', permissionMode: 'default', approvalPolicy: 'forward' })
  await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === 'second')
  const decisions = ['first', 'second'].map(toolUseID =>
    query.options?.canUseTool?.('Bash', pwd, { signal: new AbortController().signal, toolUseID } as never))
  await client.waitFor(frame => frame.type === 'tool-approval-request' && frame.approvalId === 'second')
  query.push({ type: 'stream_event', event: { type: 'message_stop' } })
  const pause = await client.waitFor(frame => frame.type === 'finish-step')
  for (const approvalId of ['first', 'second']) {
    client.send({ type: 'tool-approval-response', approvalId, approved: true })
  }
  await Promise.all(decisions)
  query.push({
    type: 'user',
    message: { content: ['first', 'second'].map(id => ({ type: 'tool_result', tool_use_id: id, content: '/work' })) },
  })
  query.push(resultMessage())
  const finish = await client.waitFor(frame => frame.type === 'finish')

  // Held back to the response's end, so one pause covers both waiting calls.
  expect(pause).toMatchObject({
    finishReason: { unified: 'tool-calls', raw: 'host-input' },
    usage: { inputTokens: { total: 0 }, outputTokens: { total: 0 } },
    harnessMetadata: { 'claude-code': { inferredStep: true } },
  })
  const stop = client.frames.findIndex(frame => frame.type === 'raw'
    && (frame.rawValue as { event?: { type?: string } }).event?.type === 'message_stop')
  expect(client.frames.indexOf(pause)).toBeGreaterThan(stop)
  expect(client.frames.filter(frame => frame.type === 'tool-call').map(frame => frame.toolCallId))
    .toEqual(['first', 'second'])
  const steps = client.frames.filter(frame => frame.type === 'finish-step')
  expect(steps.map(step => (step.finishReason as { raw: string }).raw)).toEqual(['host-input', 'stop'])
  // The pause meters nothing: the step's own end still carries the usage it streamed.
  expect(steps[1]!.usage).toMatchObject({ inputTokens: { total: 10 }, outputTokens: { total: 40 } })

  // Structure, not liveness: the journal and the transcript replayed from it hold the same pause.
  expect((await host.readJournal()).filter(frame => frame.type === 'finish-step')).toEqual(steps)
  const replayed = await connect(host)
  replayed.send({ type: 'resume', lastSeenEventId: 0 })
  await replayed.waitFor(frame => frame.type === 'finish' && frame.seq === finish.seq)
  expect(replayed.frames.filter(frame => frame.type === 'finish-step')).toEqual(steps)
  replayed.close()
  client.close()
})

it('forwards a rate_limit_event raw exactly once and maps nothing from it', async () => {
  const rateLimit = {
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed_warning', rateLimitType: 'five_hour' },
    session_id: 'sess-1',
  }
  const query = createFakeQuery([initMessage(), rateLimit, resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const raws = client.frames.filter(frame => frame.type === 'raw')
  expect(raws.map(frame => frame.rawValue)).toEqual([initMessage(), rateLimit, resultMessage()])
  // Between its raw and the result's, nothing was derived from it.
  const index = client.frames.indexOf(raws[1]!)
  expect(client.frames[index + 1]).toBe(raws[2])
  client.close()
})

it('closes the synthetic step of a compaction reported outside a model step', async () => {
  const query = createFakeQuery([
    initMessage(),
    { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 900 } },
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'raw'
    && (frame.rawValue as { subtype?: string }).subtype === 'compact_boundary')
  const postCompact = query.options?.hooks?.PostCompact?.[0]?.hooks?.[0]
  await postCompact?.(
    { compact_summary: 'the summary' } as never,
    undefined,
    { signal: new AbortController().signal },
  )
  const compaction = await client.waitFor(frame => frame.type === 'compaction')
  query.push(resultMessage())
  await client.waitFor(frame => frame.type === 'finish')

  expect(compaction).toMatchObject({ trigger: 'manual', summary: 'the summary', tokensBefore: 900 })
  const steps = client.frames.filter(frame => frame.type === 'finish-step')
  expect(steps).toHaveLength(1)
  expect(client.frames.indexOf(steps[0]!)).toBe(client.frames.indexOf(compaction) + 1)
  client.close()
})

it('keeps a tool result\'s non-text content and an MCP scalar as sent, and skips string content', async () => {
  const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } }
  const query = createFakeQuery([
    initMessage(),
    // The first user turn can arrive as a bare string; it holds no blocks to map.
    { type: 'user', message: { content: 'do the thing' } },
    {
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/a.png' } },
        { type: 'tool_use', id: 'toolu_2', name: 'mcp__calc__add', input: { a: 1, b: 2 } },
      ] },
    },
    {
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: [image] },
        { type: 'tool_result', tool_use_id: 'toolu_2', content: '3' },
      ] },
    },
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const results = client.frames.filter(frame => frame.type === 'tool-result')
  expect(results.map(frame => [frame.toolCallId, frame.result])).toEqual([
    ['toolu_1', [image]],
    // `3` parses as JSON too, but a scalar is the text the server sent, not a structure.
    ['toolu_2', '3'],
  ])
  expect(client.frames.some(frame => frame.type === 'error')).toBe(false)
  client.close()
})

it('leaves a question\'s tool-call to the hook, and names its result askUserQuestions', async () => {
  const query = createFakeQuery([
    initMessage(),
    { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion' } } },
    { type: 'stream_event', event: { type: 'content_block_stop', index: 0 } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_q', name: 'AskUserQuestion', input: { questions: [] } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_q', content: 'apple' }] } },
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  // No hook ran in this fake, so nothing emitted the call: the stream mapper did not either.
  expect(client.frames.some(frame => frame.type === 'tool-call' || frame.type === 'tool-input-start')).toBe(false)
  expect(client.frames.find(frame => frame.type === 'tool-result')).toMatchObject({
    toolCallId: 'toolu_q',
    toolName: 'askUserQuestions',
  })
  client.close()
})

it('reports the CLI\'s structured tool result, without the pre-edit file', async () => {
  const edit = {
    filePath: '/workspace/repo/a.ts',
    oldString: 'a',
    newString: 'b',
    originalFile: 'a\n'.repeat(1000),
    structuredPatch: [{ oldStart: 1, lines: ['-a', '+b'] }],
  }
  const query = createFakeQuery([
    initMessage(),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: {} }] } },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'edited' }] },
      tool_use_result: edit,
    },
    {
      type: 'assistant',
      message: { content: [
        { type: 'tool_use', id: 'toolu_2', name: 'Read', input: {} },
        { type: 'tool_use', id: 'toolu_3', name: 'Read', input: {} },
      ] },
    },
    // Two results and one structured value: whose it is cannot be told, so the text is used.
    {
      type: 'user',
      message: { content: [
        { type: 'tool_result', tool_use_id: 'toolu_2', content: 'one' },
        { type: 'tool_result', tool_use_id: 'toolu_3', content: 'two' },
      ] },
      tool_use_result: { file: { content: 'one' } },
    },
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const { originalFile: _originalFile, ...reported } = edit
  const results = client.frames.filter(frame => frame.type === 'tool-result')
  expect(results.map(frame => [frame.toolCallId, frame.result])).toEqual([
    ['toolu_1', reported],
    ['toolu_2', 'one'],
    ['toolu_3', 'two'],
  ])
  // The raw `user` frame still carries the whole value: the transcript keeps what the part drops.
  const raw = client.frames.find(frame => frame.type === 'raw'
    && (frame.rawValue as { tool_use_result?: unknown }).tool_use_result !== undefined)
  expect((raw?.rawValue as { tool_use_result: unknown }).tool_use_result).toEqual(edit)
  client.close()
})

it('keeps originalFile on a structured result that is not Edit\'s or Write\'s', async () => {
  const own = { originalFile: 'the server\'s own field', status: 'ok' }
  const query = createFakeQuery([
    initMessage(),
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_m', name: 'mcp__files__restore', input: {} }] } },
    {
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_m', content: 'restored' }] },
      tool_use_result: own,
    },
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  expect(client.frames.find(frame => frame.type === 'tool-result')?.result).toEqual(own)
  client.close()
})

it('reports the session transcript and journal paths on finish', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  const artifacts = finish.sessionArtifacts as {
    sessionId: string
    sessionTranscriptPath: string
    journalPath: string
  }
  expect(artifacts.sessionTranscriptPath).toMatch(
    /\/projects\/-workspace-repo\/sess-1\.jsonl$/,
  )
  // The id itself, not only the file named after it: a resuming client sends
  // it as `start.resume` rather than parsing it back out of the path.
  expect(artifacts.sessionId).toBe('sess-1')
  expect(artifacts.journalPath).toBe(host.journalPath)
  expect(finish.stopped).toBe('completed')
  client.close()
})

it('names the deferred call on a finish that stopped for one', async () => {
  const query = createFakeQuery([
    initMessage(),
    resultMessage({
      terminal_reason: 'tool_deferred',
      deferred_tool_use: { id: 'call-9', name: 'Bash', input: { command: 'gh pr merge' } },
    }),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  // `stopped` says a decision is owed; `deferredToolUse` says which request it is owed about,
  // which is what makes an answer authorize one request rather than the tool.
  expect(finish.stopped).toBe('deferred')
  expect(finish.deferredToolUse).toEqual({
    id: 'call-9',
    name: 'Bash',
    input: { command: 'gh pr merge' },
  })
  client.close()
})

/*
 * A run-phase `error` is how a turn ordinarily fails, and `system`/`init` has
 * already named a session by then — so the client that retries the attempt is
 * told which session to resume, exactly as a `finish` would.
 */
it('reports the session artifacts on a run-phase error too', async () => {
  // A `result` the CLI did not call a success is the ordinary run-phase failure.
  const query = createFakeQuery([
    initMessage(),
    resultMessage({ subtype: 'error_during_execution', errors: ['the model went away'] }),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const failure = await client.waitFor(frame => frame.type === 'error')

  expect(failure.phase).toBe('run')
  const artifacts = failure.sessionArtifacts as {
    sessionId: string
    sessionTranscriptPath: string
    journalPath: string
  }
  expect(artifacts.sessionId).toBe('sess-1')
  expect(artifacts.sessionTranscriptPath).toMatch(
    /\/projects\/-workspace-repo\/sess-1\.jsonl$/,
  )
  expect(artifacts.journalPath).toBe(host.journalPath)
  client.close()
})

/*
 * A `CLAUDE_CONFIG_DIR` on `start.env` moves the CLI's `projects/` tree, so the
 * reported transcript has to be resolved against the environment the child got
 * — not the host's own, which is what the bridge process was launched with.
 */
it('resolves the session transcript against the child environment', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({
    type: 'start',
    prompt: 'do the thing',
    env: { CLAUDE_CONFIG_DIR: '/tmp/alt-config' },
  })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  const artifacts = finish.sessionArtifacts as {
    sessionTranscriptPath: string
  }
  expect(artifacts.sessionTranscriptPath).toBe(
    '/tmp/alt-config/projects/-workspace-repo/sess-1.jsonl',
  )
  client.close()
})

/*
 * `persistSession: false` tells the SDK to write no session file at all, so a
 * reported path would name a transcript that does not exist. The journal is the
 * bridge's own file and is unaffected.
 */
it('reports no transcript path when the turn does not persist its session', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing', persistSession: false })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  const artifacts = finish.sessionArtifacts as {
    sessionTranscriptPath?: string
    journalPath: string
  }
  expect(artifacts.sessionTranscriptPath).toBeUndefined()
  expect(artifacts.journalPath).toBe(host.journalPath)
  client.close()
})

it('delivers each frame once when a resume lands mid-journal', async () => {
  // Enough frames that the awaited appends are still draining when the second
  // socket resumes: that window is the one where `replay` and the journal
  // chain can both reach for the same frame.
  const chatter = Array.from({ length: 400 }, (_, index) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text: `line ${index}` }] },
  }))
  const query = createFakeQuery([initMessage(), ...chatter, resultMessage()])
  host = await startHost({ query: query.fn })
  const first = await connect(host)
  const second = await connect(host)

  first.send({ type: 'start', prompt: 'do the thing' })
  // Resume once the first socket has seen a frame: the chain has then drained
  // one append and the rest of the turn is queued behind it, so `replay` reads
  // a log whose tail the chain is still holding.
  await first.waitFor(frame => frame.type === 'raw')
  second.send({ type: 'resume', lastSeenEventId: 0 })
  await second.waitFor(frame => frame.type === 'finish')
  // `finish` arrives on the replayed tail, so the frames the chain still holds
  // land after it. Stop the host and wait for the close it sends once the chain
  // has fully drained: only then is the delivery count final.
  second.send({ type: 'stop' })
  await second.closed

  const seqs = second.frames
    .map(frame => frame.seq)
    .filter((seq): seq is number => seq !== undefined)
  expect(new Set(seqs).size).toBe(seqs.length)
  // Every journaled frame reached the resumed socket, in order and with no gap.
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1))

  first.close()
})

/**
 * The journal-before-send invariant has to hold on the resume path too. `replay`
 * used to read the in-memory log and write straight to the socket, so a frame
 * whose append was still queued could reach the host before it was on disk —
 * exactly the window the Worker's `turn_end` mirror reads across.
 */
it('journals every replayed frame before the resumed socket sees it', async () => {
  const chatter = Array.from({ length: 400 }, (_, index) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text: `line ${index}` }] },
  }))
  const query = createFakeQuery([initMessage(), ...chatter, resultMessage()])
  host = await startHost({ query: query.fn })
  const first = await connect(host)
  // Read the journal as each frame lands, not afterwards: by the end everything
  // is on disk and the race this covers would leave no trace.
  const unjournaled: number[] = []
  const second = await connect(host, (frame) => {
    if (frame.seq === undefined) {
      return
    }
    const journaled = readFileSync(host!.journalPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => (JSON.parse(line) as { seq: number }).seq)
    if (!journaled.includes(frame.seq)) {
      unjournaled.push(frame.seq)
    }
  })

  first.send({ type: 'start', prompt: 'do the thing' })
  await first.waitFor(frame => frame.type === 'raw')
  second.send({ type: 'resume', lastSeenEventId: 0 })
  await second.waitFor(frame => frame.type === 'finish')
  second.send({ type: 'stop' })
  await second.closed

  expect(unjournaled).toEqual([])
  first.close()
})

/*
 * The replay boundary (`harness-bridge-runtime` UPSTREAM.md patch 36). A client that has to
 * stop a turn right after the replay cannot find its end from `lastSeq`, which counts live-only
 * frames no replay sends, so the bridge says where it is.
 */
it('advertises the resume acknowledgement in its greeting', async () => {
  host = await startHost({ query: createFakeQuery([]).fn })
  const client = await connect(host)

  const hello = await client.waitFor(frame => frame.type === 'bridge-hello')
  expect(hello.capabilities).toMatchObject({ resumeAck: true })
  client.close()
})

it('ends a replayed tail with bridge-resumed naming the boundary it covered', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const first = await connect(host)
  first.send({ type: 'start', prompt: 'do the thing' })
  const finish = await first.waitFor(frame => frame.type === 'finish')

  const second = await connect(host)
  second.send({ type: 'resume', lastSeenEventId: 1 })
  const resumed = await second.waitFor(frame => frame.type === 'bridge-resumed')

  expect(resumed).toEqual({ type: 'bridge-resumed', upTo: finish.seq })
  const replayed = second.frames.slice(second.frames.findIndex(frame => frame.type === 'bridge-hello') + 1)
  // The tail past the cursor, in order, and the ack after the last of it.
  expect(replayed.map(frame => frame.seq)).toEqual([
    ...Array.from({ length: finish.seq! - 1 }, (_, index) => index + 2),
    undefined,
  ])
  expect(replayed.at(-1)?.type).toBe('bridge-resumed')
  second.close()
  first.close()
})

it('acknowledges a resume that has nothing to replay', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const first = await connect(host)
  first.send({ type: 'start', prompt: 'do the thing' })
  const finish = await first.waitFor(frame => frame.type === 'finish')

  const second = await connect(host)
  second.send({ type: 'resume', lastSeenEventId: finish.seq })
  const resumed = await second.waitFor(frame => frame.type === 'bridge-resumed')

  expect(resumed).toEqual({ type: 'bridge-resumed', upTo: finish.seq })
  expect(second.frames.filter(frame => frame.seq !== undefined)).toEqual([])
  second.close()
  first.close()
})

it('sends a frame emitted after the resume behind the acknowledgement', async () => {
  const query = createFakeQuery([initMessage()])
  host = await startHost({ query: query.fn })
  const first = await connect(host)
  first.send({ type: 'start', prompt: 'do the thing' })
  await first.waitFor(frame => frame.type === 'raw')

  const second = await connect(host)
  second.send({ type: 'resume', lastSeenEventId: 0 })
  await second.waitFor(frame => frame.type === 'bridge-resumed')
  query.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'later' }] } })
  query.push(resultMessage())
  await second.waitFor(frame => frame.type === 'finish')

  const types = second.frames.map(frame => frame.type)
  const ack = types.indexOf('bridge-resumed')
  const upTo = second.frames[ack]?.upTo as number
  expect(ack).toBeGreaterThan(0)
  // Everything at or below the boundary is ahead of the ack, everything past it behind.
  second.frames.forEach((frame, index) => {
    if (frame.seq !== undefined) {
      expect(frame.seq <= upTo).toBe(index < ack)
    }
  })
  expect(second.frames.slice(ack + 1).some(frame => frame.type === 'finish')).toBe(true)
  second.close()
  first.close()
})

it('keeps the frame chain alive when a replayed send throws', async () => {
  // Capture the bridge's own sockets: under bun they are not `ws` WebSocket instances, so the
  // throw has to be planted on the one socket, not on a prototype.
  const accepted: WebSocket[] = []
  const on = WebSocketServer.prototype.on
  const spy = vi.spyOn(WebSocketServer.prototype, 'on').mockImplementation(function (this: WebSocketServer, event: string | symbol, listener: (...args: any[]) => void) {
    if (event !== 'connection') {
      return on.call(this, event, listener)
    }
    return on.call(this, event, (ws: WebSocket, ...rest: unknown[]) => {
      accepted.push(ws)
      listener(ws, ...rest)
    })
  })
  try {
    const query = createFakeQuery([initMessage(), resultMessage()])
    host = await startHost({ query: query.fn })
    const first = await connect(host)
    first.send({ type: 'start', prompt: 'do the thing' })
    const finish = await first.waitFor(frame => frame.type === 'finish')

    const second = await connect(host)
    await second.waitFor(frame => frame.type === 'bridge-hello')
    const failing = accepted.at(-1)!
    const send = failing.send.bind(failing)
    failing.send = ((data: string, ...rest: never[]) => {
      if (data.includes('"seq":')) {
        throw new Error('socket went away')
      }
      return send(data, ...rest)
    }) as WebSocket['send']
    second.send({ type: 'resume', lastSeenEventId: 0 })
    // Its tail is counted as delivered, so the socket is dropped rather than left to take
    // later frames past the gap: the host reconnects and resumes from what it really has.
    await second.closed

    // A later resume still runs: the throw did not reject the chain it sits behind.
    const third = await connect(host)
    third.send({ type: 'resume', lastSeenEventId: 0 })
    const resumed = await third.waitFor(frame => frame.type === 'bridge-resumed')

    expect(resumed).toEqual({ type: 'bridge-resumed', upTo: finish.seq })
    // The tail that failed is not acknowledged, so it is never read as a boundary.
    expect(second.frames.some(frame => frame.type === 'bridge-resumed')).toBe(false)
    third.close()
    first.close()
  }
  finally {
    spy.mockRestore()
  }
})
