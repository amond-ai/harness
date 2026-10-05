import type { Frame, Host } from './harness'
import { afterEach, expect, it } from 'vitest'
import {
  connect,
  createFakeQuery,
  initMessage,
  resultMessage,
  startHost,
} from './harness'

let host: Host | undefined

afterEach(async () => {
  await host?.close()
  host = undefined
})

function backgroundTasks(
  tasks: Array<{ task_id: string, ambient?: boolean }>,
): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'background_tasks_changed',
    tasks: tasks.map(task => ({ task_type: 'local_agent', description: 'doc-writer', ...task })),
    session_id: 'sess-1',
  }
}

function taskNotification(taskId: string): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'task_notification',
    task_id: taskId,
    status: 'completed',
    output_file: `/tmp/${taskId}.output`,
    summary: `${taskId} wrote the document`,
    session_id: 'sess-1',
  }
}

/** The `result` of the turn the CLI injects when background work settles. */
function followUpResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return resultMessage({ origin: { kind: 'task-notification' }, num_turns: 1, ...overrides })
}

function isRaw(subtype: string): (frame: Frame) => boolean {
  return frame => frame.type === 'raw' && (frame.rawValue as { subtype?: string }).subtype === subtype
}

it('finishes a turn only after its background subagent settles and the turn it wakes ends', async () => {
  const query = createFakeQuery([
    initMessage(),
    backgroundTasks([{ task_id: 'task-1' }]),
    resultMessage({ result: 'waiting on the doc-writer', total_cost_usd: 0.01 }),
    backgroundTasks([]),
    taskNotification('task-1'),
    followUpResult({ result: 'opened the pull request', total_cost_usd: 0.03 }),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'document the feature' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  // The settled subagent's result reached the client and the journal before the turn ended.
  expect(client.frames.findIndex(isRaw('task_notification')))
    .toBeLessThan(client.frames.indexOf(finish))
  expect((await host.readJournal()).some(isRaw('task_notification'))).toBe(true)
  expect(finish.stopped).toBe('completed')
  // `total_cost_usd` is a running total: the latest result's, not the sum of both.
  expect(finish.harnessMetadata).toEqual({ 'claude-code': { costUsd: 0.03, sessionId: 'sess-1' } })
  expect(query.returnCount).toBe(1)
})

it('finishes on the first result when only ambient tasks are running', async () => {
  const query = createFakeQuery([
    initMessage(),
    backgroundTasks([{ task_id: 'watcher-1', ambient: true }]),
    resultMessage(),
    // Never read: the turn ended on the result above.
    taskNotification('watcher-1'),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  expect(finish.stopped).toBe('completed')
  expect(client.frames.some(isRaw('task_notification'))).toBe(false)
})

it('ends a deferred turn at once instead of waiting for background tasks', async () => {
  const deferredToolUse = { id: 'call-1', name: 'Bash', input: { command: 'ls' } }
  const query = createFakeQuery([
    initMessage(),
    backgroundTasks([{ task_id: 'task-1' }]),
    resultMessage({ terminal_reason: 'tool_deferred', deferred_tool_use: deferredToolUse }),
    // Never read: the deferral ended the turn so the caller can route it to approval.
    taskNotification('task-1'),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  expect(finish.stopped).toBe('deferred')
  expect(finish.deferredToolUse).toEqual(deferredToolUse)
  expect(client.frames.some(isRaw('task_notification'))).toBe(false)
})

it('waits past the empty results of completions answered together for the one that carries the turn', async () => {
  const query = createFakeQuery([
    initMessage(),
    backgroundTasks([{ task_id: 'task-1' }, { task_id: 'task-2' }]),
    resultMessage({ total_cost_usd: 0.01 }),
    backgroundTasks([]),
    taskNotification('task-1'),
    taskNotification('task-2'),
    followUpResult({ result: '', num_turns: 0, total_cost_usd: 0.01 }),
    followUpResult({ result: 'both stages reported', num_turns: 2, total_cost_usd: 0.05 }),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'document the feature' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  // Ending on the empty result would report its 0.01 and drop the turn that answers both.
  expect(finish.harnessMetadata).toEqual({ 'claude-code': { costUsd: 0.05, sessionId: 'sess-1' } })
  expect(client.frames.filter(frame => frame.type === 'raw'
    && (frame.rawValue as { type: string }).type === 'result')).toHaveLength(3)
})

it('ends a turn whose background task never settles through the watchdog interrupt', async () => {
  const query = createFakeQuery([
    initMessage(),
    backgroundTasks([{ task_id: 'task-1' }]),
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'document the feature' })
  await client.waitFor(frame => frame.type === 'raw'
    && (frame.rawValue as { type: string }).type === 'result')
  // Still reading past the result: a turn that had ended would never forward this.
  query.push({ type: 'system', subtype: 'task_progress', task_id: 'task-1', description: 'writing', session_id: 'sess-1' })
  await client.waitFor(isRaw('task_progress'))
  expect(client.frames.some(frame => frame.type === 'finish')).toBe(false)

  client.send({ type: 'interrupt', reason: 'watchdog' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  expect(query.interruptCount).toBe(1)
  expect(finish.stopped).toBe('interrupted')
  expect(finish.interruptedBy).toBe('watchdog')
})
