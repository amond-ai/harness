import type { Host } from './harness'
import { afterEach, expect, it } from 'vitest'
import {
  agentMessageEvents,
  commandExecutionEvents,
  connect,
  createFakeCodex,
  startHost,
  successfulTurn,
  threadStarted,
  turnCompleted,
} from './harness'

let host: Host | undefined

afterEach(async () => {
  await host?.close()
  host = undefined
})

it('translates an agent message into a text part and journals every delta', async () => {
  const codex = createFakeCodex(successfulTurn())
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const text = client.frames.filter(frame => frame.type.startsWith('text-'))
  expect(text.map(frame => frame.type)).toEqual([
    'text-start',
    'text-delta',
    'text-end',
  ])
  expect(text[1]?.delta).toBe('hi')

  /*
   * The Claude bridge keeps its deltas out of the journal because the same text
   * arrives again on a `raw` frame. Codex emits no `raw` frames, so here the
   * deltas are the transcript and a reconnect has to get them back.
   */
  const journal = await host.readJournal()
  expect(journal.filter(frame => frame.type === 'text-delta')).toHaveLength(1)

  const replayed = await connect(host)
  replayed.send({ type: 'resume', lastSeenEventId: 0 })
  await replayed.waitFor(frame => frame.type === 'finish')
  expect(replayed.frames.some(frame => frame.type === 'text-delta')).toBe(true)
  replayed.close()
  client.close()
})

it('reports the journal, the stop and the mapped usage on finish', async () => {
  const codex = createFakeCodex(successfulTurn())
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  expect(finish.stopped).toBe('completed')
  // Flat and optional, not wrapped in a `sessionArtifacts` envelope: the journal
  // is the runtime's own property, and Codex's session has no file beside it to
  // share the envelope with.
  expect(finish.journalPath).toBe(host.journalPath)
  expect(finish).not.toHaveProperty('interruptedBy')
  expect(finish.totalUsage).toEqual({
    // Cache writes and reasoning tokens are reported, not flattened away: a
    // reasoning-heavy turn would otherwise read as all visible text.
    inputTokens: { total: 10, noCache: 6, cacheRead: 4, cacheWrite: 3 },
    outputTokens: { total: 7, text: 2, reasoning: 5 },
  })
  client.close()
})

it('announces the thread id as it starts and hands it back on stop', async () => {
  const codex = createFakeCodex(successfulTurn())
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const announced = await client.waitFor(frame => frame.type === 'bridge-thread')
  await client.waitFor(frame => frame.type === 'finish')

  // Announced mid-turn rather than only on `stop`: a process that dies still
  // leaves the client a thread to resume.
  expect(announced.threadId).toBe('thr-1')

  client.send({ type: 'stop' })
  const stopped = await client.waitFor(frame => frame.type === 'bridge-stop')
  expect(stopped.data).toEqual({ threadId: 'thr-1' })
})

it('emits a command execution as a tool round trip inside an inferred step', async () => {
  const codex = createFakeCodex([
    threadStarted(),
    ...commandExecutionEvents(),
    ...agentMessageEvents('done'),
    turnCompleted(),
  ])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'list the files' })
  await client.waitFor(frame => frame.type === 'finish')

  const call = client.frames.find(frame => frame.type === 'tool-call')
  expect(call).toMatchObject({
    toolName: 'bash',
    nativeName: 'shell',
    providerExecuted: true,
  })
  expect(JSON.parse(String(call?.input))).toEqual({ command: 'ls' })

  const result = client.frames.find(frame => frame.type === 'tool-result')
  expect(result?.result).toEqual({
    exitCode: 0,
    output: 'README.md\n',
    status: 'completed',
  })
  expect(result?.isError).toBe(false)

  // Codex reports items, not steps, so the boundary is this host's reading of
  // the item stream — and says so on the frame.
  const step = client.frames.find(frame => frame.type === 'finish-step')
  expect(step?.harnessMetadata).toEqual({ codex: { inferredStep: true } })
  client.close()
})

it('flags a failed command execution as an error tool result', async () => {
  const codex = createFakeCodex([
    threadStarted(),
    {
      type: 'item.started',
      item: { id: 'item-cmd-2', type: 'command_execution', command: 'false', status: 'in_progress' },
    },
    {
      type: 'item.completed',
      item: {
        id: 'item-cmd-2',
        type: 'command_execution',
        command: 'false',
        aggregated_output: 'boom\n',
        exit_code: 1,
        status: 'failed',
      },
    },
    turnCompleted(),
  ])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'run it' })
  await client.waitFor(frame => frame.type === 'finish')

  // Without the flag a failed shell command reads exactly like a successful
  // one on the field consumers check generically.
  expect(client.frames.find(frame => frame.type === 'tool-result')?.isError).toBe(true)
  client.close()
})

it('reports file changes for an applied patch and none for a failed one', async () => {
  const codex = createFakeCodex([
    threadStarted(),
    {
      type: 'item.completed',
      item: {
        id: 'item-patch-1',
        type: 'file_change',
        status: 'completed',
        changes: [{ path: '/workspace/repo/a.ts', kind: 'update' }],
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'item-patch-2',
        type: 'file_change',
        status: 'failed',
        changes: [{ path: '/workspace/repo/b.ts', kind: 'add' }],
      },
    },
    turnCompleted(),
  ])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'patch it' })
  await client.waitFor(frame => frame.type === 'finish')

  // Codex emits the completed item whether the patch applied or not, so a
  // failed one must not leave the client recording a change that never landed.
  const changes = client.frames.filter(frame => frame.type === 'file-change')
  expect(changes).toHaveLength(1)
  expect(changes[0]).toMatchObject({ event: 'modify', path: '/workspace/repo/a.ts' })
  client.close()
})

it('keeps a failed mcp tool call distinct from a successful one', async () => {
  const codex = createFakeCodex([
    threadStarted(),
    {
      type: 'item.started',
      item: { id: 'item-mcp-1', type: 'mcp_tool_call', tool: 'lookup', arguments: { q: 'x' } },
    },
    {
      type: 'item.completed',
      item: {
        id: 'item-mcp-1',
        type: 'mcp_tool_call',
        tool: 'lookup',
        status: 'completed',
        result: { structured_content: { found: true } },
      },
    },
    {
      type: 'item.started',
      item: { id: 'item-mcp-2', type: 'mcp_tool_call', tool: 'lookup', arguments: { q: 'y' } },
    },
    {
      type: 'item.completed',
      item: {
        id: 'item-mcp-2',
        type: 'mcp_tool_call',
        tool: 'lookup',
        status: 'failed',
        error: { message: 'the server refused' },
      },
    },
    turnCompleted(),
  ])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'look it up' })
  await client.waitFor(frame => frame.type === 'finish')

  const results = client.frames.filter(frame => frame.type === 'tool-result')
  expect(results[0]).toMatchObject({ result: { found: true }, isError: false })
  expect(results[1]).toMatchObject({
    result: { error: 'the server refused' },
    isError: true,
  })
  client.close()
})

it('reports an error item as a warning rather than an ending', async () => {
  const codex = createFakeCodex([
    threadStarted(),
    {
      type: 'item.completed',
      item: { id: 'item-err-1', type: 'error', message: 'retrying the shell call' },
    },
    ...agentMessageEvents('recovered'),
    turnCompleted(),
  ])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  // A step Codex recovered from is not the turn's outcome: an `error` frame
  // here would be read as one.
  expect(client.frames.some(frame => frame.type === 'error')).toBe(false)
  expect(finish.stopped).toBe('completed')
  client.close()
})

it('acknowledges a start before codex has said anything', async () => {
  const codex = createFakeCodex(successfulTurn())
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const types = client.frames.map(frame => frame.type)
  expect(types.indexOf('bridge-started')).toBeGreaterThan(types.indexOf('bridge-hello'))
  expect(types.indexOf('bridge-started')).toBeLessThan(types.indexOf('stream-start'))
  client.close()
})
