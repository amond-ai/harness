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
    inputTokens: { total: 10, noCache: 6, cacheRead: 4, cacheWrite: 0 },
    outputTokens: { total: 2, text: 2 },
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

  expect(client.frames.find(frame => frame.type === 'tool-result')?.result).toEqual({
    exitCode: 0,
    output: 'README.md\n',
    status: 'completed',
  })

  // Codex reports items, not steps, so the boundary is this host's reading of
  // the item stream — and says so on the frame.
  const step = client.frames.find(frame => frame.type === 'finish-step')
  expect(step?.harnessMetadata).toEqual({ codex: { inferredStep: true } })
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
