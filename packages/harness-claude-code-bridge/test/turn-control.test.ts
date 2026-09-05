import type { Host } from './harness'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, expect, it } from 'vitest'
import { runBridge } from '../src/bridge-runtime'
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

it('interrupts the query and finishes the turn as interrupted', async () => {
  // No `result` in the script: the turn only ends because `interrupt()` puts
  // one there, the way the real SDK does.
  const query = createFakeQuery([initMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )

  client.send({ type: 'interrupt', reason: 'watchdog' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  expect(query.interruptCount).toBe(1)
  expect(finish.stopped).toBe('interrupted')
})

it('answers an interrupt with no running turn on that socket alone', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'interrupt', reason: 'operator' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('run')
  expect(error.error).toBe('no running turn to interrupt')
  // A control frame, not an event: it consumes no `seq` and is not journaled.
  expect(error.seq).toBeUndefined()
  expect(await host.readJournal()).toHaveLength(0)
})

it('fails a routed turn whose command is missing from slash_commands', async () => {
  const query = createFakeQuery([
    initMessage({ slash_commands: ['compact', 'clear'] }),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: '/software-factory:implement #360' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('init')
  expect(error.error).toContain('software-factory:implement')
  expect(client.frames.some(frame => frame.type === 'finish')).toBe(false)
})

it('refuses a start carrying tools without calling query()', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({
    type: 'start',
    prompt: 'do the thing',
    tools: [{ name: 'lookup' }],
  })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('start')
  expect(query.called).toBe(false)
})

it('refuses a start whose fields do not validate without calling query()', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing', maxTurns: 'lots' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('start')
  expect(query.called).toBe(false)
})

/**
 * One turn at a time. A second `start` used to be accepted mid-turn: it closed
 * the first turn's user-message queue, replaced the abort controller and the
 * event log, and left the first `onStart` running, so both turns wrote onto one
 * stream. It is refused on the sending socket instead, and the running turn
 * carries on to its single `finish`.
 */
it('refuses a start while a turn is running', async () => {
  const query = createFakeQuery([initMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )

  client.send({ type: 'start', prompt: 'and another' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('start')
  expect(error.error).toBe('a bridge turn is already running')
  // A control frame on that socket alone: no `seq`, nothing on the event stream.
  expect(error.seq).toBeUndefined()

  // The first turn was never disturbed — it still runs, and ends exactly once.
  query.push(resultMessage())
  await client.waitFor(frame => frame.type === 'finish')
  expect(client.frames.filter(frame => frame.type === 'finish')).toHaveLength(1)
  expect(query.callCount).toBe(1)
})

/**
 * The SDK documents `continue` and `resume` as mutually exclusive, so the
 * implicit "every turn after the first continues" rule cannot stand when the
 * host asked for a specific session: the query would fail at startup. A turn
 * that names no session still continues, which is what makes this a rule and
 * not a blanket removal.
 */
it('lets an explicit resume suppress the implicit continue', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'first' })
  await client.waitFor(frame => frame.type === 'finish')
  expect(query.options?.continue).toBeUndefined()

  // The fake `query` shares one message queue across calls, so the next turn's
  // script is queued before the `start` that consumes it.
  query.push(initMessage())
  query.push(resultMessage())
  client.send({ type: 'start', prompt: 'second', resume: 'sess-1' })
  await client.waitFor(
    () => client.frames.filter(frame => frame.type === 'finish').length === 2,
  )
  expect(query.options?.resume).toBe('sess-1')
  expect(query.options?.continue).toBeUndefined()

  query.push(initMessage())
  query.push(resultMessage())
  client.send({ type: 'start', prompt: 'third' })
  await client.waitFor(
    () => client.frames.filter(frame => frame.type === 'finish').length === 3,
  )
  expect(query.options?.resume).toBeUndefined()
  expect(query.options?.continue).toBe(true)
})

/**
 * The bridge binds `0.0.0.0`, so the channel token is the only thing between that
 * port and a turn. With none configured the check compared `''` to `''` and an
 * empty `agent_bridge_token` was accepted — a fail-open default. There is no
 * listener at all now.
 */
it('refuses to start without a channel token', async () => {
  const bridgeStateDir = await mkdtemp(join(tmpdir(), 'turn-host-test-'))
  const inherited = process.env.BRIDGE_CHANNEL_TOKEN
  delete process.env.BRIDGE_CHANNEL_TOKEN

  try {
    await expect(runBridge({
      bridgeType: 'claude-code',
      bridgeStateDir,
      port: 0,
      onStart: () => Promise.resolve(),
      onExit: () => {},
    })).rejects.toThrow('bridge channel token is required')
  }
  finally {
    if (inherited !== undefined) {
      process.env.BRIDGE_CHANNEL_TOKEN = inherited
    }
  }
})

/**
 * A Task subagent's messages carry `parent_tool_use_id` and its own recoverable
 * `error` fields (`rate_limit`, `overloaded`, …) that it retries past. Latching
 * one as the *parent* turn's terminal error ended a turn that went on to succeed
 * on an `error` frame with no `finish`: the driver reads that latch together with
 * an empty `result`, which is exactly what a `structured_output` answer leaves.
 */
it('does not latch a Task subagent\'s recoverable error onto the parent turn', async () => {
  const query = createFakeQuery([
    initMessage(),
    {
      type: 'assistant',
      parent_tool_use_id: 'toolu_task_1',
      error: 'rate_limit',
      message: { content: [{ type: 'text', text: 'retrying' }] },
    },
    resultMessage({ result: '', structured_output: { ok: true } }),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({
    type: 'start',
    prompt: 'do the thing',
    responseFormat: { type: 'json' },
  })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  expect(finish.stopped).toBe('completed')
  expect(client.frames.some(frame => frame.type === 'error')).toBe(false)
})
