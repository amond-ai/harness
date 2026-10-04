import type { QueryFn } from '../src/turn-driver'
import type { FakeQuery, Host } from './harness'
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
  // Echoed back, because the Worker's own record of the stop it asked for is not durable (#388).
  expect(finish.interruptedBy).toBe('watchdog')
})

it('names the interrupt on the run-phase error it escalated into', async () => {
  // Nothing after `init`, and an `interrupt()` that yields no `result` either: the only way this
  // turn ends is the host's own escalation, once the grace runs out.
  const query = createFakeQuery([initMessage()], { resultOnInterrupt: false })
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing', interruptGraceMs: 10 })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )

  client.send({ type: 'interrupt', reason: 'budget' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('run')
  expect(error.interruptedBy).toBe('budget')
})

it('names the interrupt on a terminal error that landed during the wind-down', async () => {
  // The third run-phase error site: the interrupt was answered, but with a `result` that
  // failed rather than the graceful one — an auth or retry failure landing mid-wind-down. That
  // is the interrupt's ending as much as the escalation is, so it names the stop too.
  const query = createFakeQuery([initMessage()], {
    resultOnInterrupt: { subtype: 'error_during_execution', result: 'the model went away' },
  })
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )

  client.send({ type: 'interrupt', reason: 'watchdog' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('run')
  // The terminal-error path's own text, not the escalation's `no result within …`.
  expect(error.error).toBe('the model went away')
  expect(error.interruptedBy).toBe('watchdog')
  expect(client.frames.some(frame => frame.type === 'finish')).toBe(false)
})

it('fails a turn whose success result the CLI flagged as an error', async () => {
  const query = createFakeQuery([
    initMessage(),
    resultMessage({ is_error: true, result: 'Prompt is too long' }),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('run')
  expect(error.error).toBe('Prompt is too long')
  expect(error.sessionArtifacts).toMatchObject({ sessionId: 'sess-1' })
  expect(client.frames.some(frame => frame.type === 'finish')).toBe(false)
})

it('names the HTTP status when a flagged result carries no message', async () => {
  const query = createFakeQuery([
    initMessage(),
    resultMessage({ is_error: true, result: '', api_error_status: 529 }),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.error).toBe('Claude Code reported an API error (HTTP 529)')
})

it('keeps the finish of an interrupted or deferred turn whose result is flagged as an error', async () => {
  // Both endings arrive on an error-shaped `result` by construction; reading the flag there would
  // cost the caller the `stopped`, `interruptedBy` and `deferredToolUse` it acts on.
  const interrupted = createFakeQuery([initMessage()], { resultOnInterrupt: { is_error: true } })
  host = await startHost({ query: interrupted.fn })
  const client = await connect(host)
  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )
  client.send({ type: 'interrupt', reason: 'watchdog' })
  const stopped = await client.waitFor(frame => frame.type === 'finish')
  expect(stopped).toMatchObject({ stopped: 'interrupted', interruptedBy: 'watchdog' })
  expect(client.frames.some(frame => frame.type === 'error')).toBe(false)
  await host.close()

  const deferredToolUse = { id: 'call-9', name: 'Bash', input: { command: 'gh pr merge' } }
  const deferred = createFakeQuery([
    initMessage(),
    resultMessage({ is_error: true, terminal_reason: 'tool_deferred', deferred_tool_use: deferredToolUse }),
  ])
  host = await startHost({ query: deferred.fn })
  const second = await connect(host)
  second.send({ type: 'start', prompt: 'do the thing' })
  const parked = await second.waitFor(frame => frame.type === 'finish')
  expect(parked).toMatchObject({ stopped: 'deferred', deferredToolUse })
  expect(second.frames.some(frame => frame.type === 'error')).toBe(false)
})

it('leaves an SDK-side abort no one asked for without a reason to name', async () => {
  // The same `terminal_reason` an interrupt produces, arriving on its own: the turn stopped
  // early, so `stopped` says `interrupted` — but no stop was requested, so nothing named one.
  const query = createFakeQuery([
    initMessage(),
    resultMessage({ terminal_reason: 'aborted_streaming' }),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  expect(finish.stopped).toBe('interrupted')
  expect(finish).not.toHaveProperty('interruptedBy')
})

it('reports a host abort as a run-phase error, never as a completed finish', async () => {
  // `abort` tears the query down and leaves no `result`: there is no `terminal_reason` for the
  // ending to map, and mapping its absence would call the turn `completed` — which the caller
  // counts as success.
  const query = createFakeQuery([initMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )

  client.send({ type: 'abort' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('run')
  expect(error).not.toHaveProperty('interruptedBy')
  expect(client.frames.some(frame => frame.type === 'finish')).toBe(false)
})

it('aborts through the graceful interrupt, still ending on a run-phase error with the session', async () => {
  // The fake answers `interrupt()` with the interrupted `result` the real SDK persists: the abort
  // took the graceful path, and the ending is still the error the abort contract names.
  const query = createFakeQuery([initMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )
  client.send({ type: 'abort' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(query.interruptCount).toBe(1)
  // The interrupted `result` reached the record before the turn ended.
  expect(client.frames.some(frame => frame.type === 'raw'
    && (frame.rawValue as { type: string }).type === 'result')).toBe(true)
  expect(error.phase).toBe('run')
  expect(error.sessionArtifacts).toMatchObject({ sessionId: 'sess-1', journalPath: host.journalPath })
  expect(client.frames.some(frame => frame.type === 'finish')).toBe(false)
})

it('falls back to the hard abort when the graceful interrupt never answers', async () => {
  const query = createFakeQuery([initMessage()], { resultOnInterrupt: false })
  host = await startHost({ query: query.fn, abortFallbackMs: 20 })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )
  client.send({ type: 'abort' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(query.interruptCount).toBe(1)
  expect(error.phase).toBe('run')
  expect(error.sessionArtifacts).toMatchObject({ sessionId: 'sess-1' })
  expect(client.frames.some(frame => frame.type === 'finish')).toBe(false)
})

it('disposes the query on every ending', async () => {
  // A completed turn, and one that ended on a terminal error: streaming input keeps the SDK's
  // CLI child alive for more user messages, so neither may leave the query undisposed.
  const completed = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: completed.fn })
  const client = await connect(host)
  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')
  await host.close()
  expect(completed.returnCount).toBe(1)

  const failed = createFakeQuery([
    initMessage(),
    resultMessage({ subtype: 'error_during_execution', errors: ['the model went away'] }),
  ])
  host = await startHost({ query: failed.fn })
  const second = await connect(host)
  second.send({ type: 'start', prompt: 'do the thing' })
  await second.waitFor(frame => frame.type === 'error')
  // The error frame goes out before the loop unwinds into the disposal.
  await expect.poll(() => failed.returnCount).toBe(1)
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

it('refuses an interrupt reason it has no meaning for, leaving the turn running', async () => {
  // The reason is a cast on the wire, and it comes back out on the ending the host echoes — so
  // a value the host cannot name is refused on the sending socket rather than stopping a turn
  // under a name it would then have to report.
  const query = createFakeQuery([initMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )

  client.send({ type: 'interrupt', reason: 'user' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('run')
  expect(error.error).toContain('unknown interrupt reason')
  // A control frame on this socket alone: no `seq`, and the turn was never touched.
  expect(error.seq).toBeUndefined()
  expect(query.interruptCount).toBe(0)
  expect(client.frames.some(frame => frame.type === 'finish')).toBe(false)
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

/** One fake per turn, in order: a fake's queue is shared by every query it serves. */
function queriesInTurn(...fakes: FakeQuery[]): QueryFn {
  let turn = 0
  return params => fakes[turn++]!.fn(params)
}

/*
 * A retry's `start` can land while the turn it replaces is still tearing down from an `abort`.
 * The bridge fences on that teardown rather than refusing a turn that is on its way out — and
 * rather than letting the two overlap, which is what upstream falls back to.
 */
it('runs a start that arrives while an aborted turn is tearing down, once it has', async () => {
  const first = createFakeQuery([initMessage()], { resultOnInterrupt: false })
  const second = createFakeQuery([initMessage(), resultMessage()])
  const replacement = queriesInTurn(first, second)
  // How far the aborted turn had got when the replacement's query was called.
  let firstDisposedBeforeSecond: boolean | undefined
  const query: QueryFn = (params) => {
    if (first.called) {
      firstDisposedBeforeSecond = first.returnCount === 1
    }
    return replacement(params)
  }
  host = await startHost({ query, abortFallbackMs: 50 })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )
  client.send({ type: 'abort' })
  client.send({ type: 'start', prompt: 'try again' })
  await client.waitFor(frame => frame.type === 'finish')

  // Fenced, not overlapped: the aborted turn had fully wound down before the replacement began.
  expect(firstDisposedBeforeSecond).toBe(true)
  expect(client.frames.some(frame => frame.type === 'error' && frame.phase === 'start')).toBe(false)
})

it('refuses a start when the aborted turn outlasts the teardown grace', async () => {
  const first = createFakeQuery([initMessage()], { resultOnInterrupt: false })
  const second = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({
    query: queriesInTurn(first, second),
    abortFallbackMs: 1_000,
    turnTeardownGraceMs: 20,
  })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )
  client.send({ type: 'abort' })
  client.send({ type: 'start', prompt: 'try again' })
  const refusal = await client.waitFor(frame => frame.type === 'error' && frame.phase === 'start')

  expect(refusal.error).toContain('did not finish tearing down')
  // A control frame on the sending socket, and the replacement never started.
  expect(refusal.seq).toBeUndefined()
  expect(second.called).toBe(false)
  // The aborted turn still ends, once, on its own error.
  const ending = await client.waitFor(frame => frame.type === 'error' && frame.phase === 'run')
  expect(ending.seq).toEqual(expect.any(Number))
})

/**
 * The SDK documents `continue` and `resume` as mutually exclusive, so the
 * implicit "every turn after the first continues" rule cannot stand when the
 * host asked for a specific session: the query would fail at startup. A later
 * turn that names no session no longer continues either: it resumes the
 * session this bridge last observed (upstream 1.0.142), since `continue` would
 * pick whatever thread ran last in the workdir.
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
  expect(query.options?.resume).toBe('sess-1')
  expect(query.options?.continue).toBeUndefined()
})

it('resumes the session resumeSessionId names, the alias resume names, and refuses two names', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'first', resumeSessionId: 'sess-0' })
  const finish = await client.waitFor(frame => frame.type === 'finish')
  expect(query.options?.resume).toBe('sess-0')
  expect(query.options?.continue).toBeUndefined()
  // Upstream's field beside this host's: the conversation the turn belonged to.
  expect(finish.harnessMetadata).toEqual({ 'claude-code': { costUsd: 0.01, sessionId: 'sess-1' } })
  expect(finish.sessionArtifacts).toMatchObject({ sessionId: 'sess-1' })

  // The same session under both names is one name.
  query.push(initMessage())
  query.push(resultMessage())
  client.send({ type: 'start', prompt: 'second', resume: 'sess-1', resumeSessionId: 'sess-1' })
  await client.waitFor(
    () => client.frames.filter(frame => frame.type === 'finish').length === 2,
  )
  expect(query.options?.resume).toBe('sess-1')

  client.send({ type: 'start', prompt: 'third', resume: 'sess-1', resumeSessionId: 'sess-2' })
  const refusal = await client.waitFor(frame => frame.type === 'error')
  expect(refusal.phase).toBe('start')
  expect(refusal.error).toContain('different sessions')
  expect(query.callCount).toBe(2)
})

/**
 * `sessionId` opens a fresh session under a known name; the SDK documents it
 * as exclusive of `resume` and `continue`, so the implicit pin to the last
 * observed session must not join it.
 */
it('starts a later turn fresh under the sessionId it names, without the implicit pin', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'first' })
  await client.waitFor(frame => frame.type === 'finish')

  query.push(initMessage())
  query.push(resultMessage())
  client.send({ type: 'start', prompt: 'second', sessionId: 'sess-2' })
  await client.waitFor(
    () => client.frames.filter(frame => frame.type === 'finish').length === 2,
  )
  expect(query.options?.sessionId).toBe('sess-2')
  expect(query.options?.resume).toBeUndefined()
  expect(query.options?.continue).toBeUndefined()
})

it('refuses a sessionId given together with a resume name, before query() runs', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'first', sessionId: 'sess-2', resume: 'sess-1' })
  const refusal = await client.waitFor(frame => frame.type === 'error')
  expect(refusal.phase).toBe('start')
  expect(refusal.error).toContain('sessionId')
  expect(query.callCount).toBe(0)

  client.send({ type: 'start', prompt: 'second', sessionId: 'sess-2', resumeSessionId: 'sess-1' })
  await client.waitFor(() => client.frames.filter(frame => frame.type === 'error').length === 2)
  expect(query.callCount).toBe(0)
})

it('names the last observed session on stop', async () => {
  const query = createFakeQuery([initMessage(), resultMessage({ session_id: 'sess-forked' })])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'stop' })
  expect((await client.waitFor(frame => frame.type === 'bridge-stop')).data).toEqual({})
  await host.close()

  const second = createFakeQuery([initMessage(), resultMessage({ session_id: 'sess-forked' })])
  host = await startHost({ query: second.fn })
  const other = await connect(host)
  other.send({ type: 'start', prompt: 'do the thing' })
  await other.waitFor(frame => frame.type === 'finish')
  other.send({ type: 'stop' })
  // The latest message's id, not `init`'s: a resume forks the session it continues.
  expect((await other.waitFor(frame => frame.type === 'bridge-stop')).data).toEqual({ claudeSessionId: 'sess-forked' })
})

it('reports the latest observed session in the finish artifacts', async () => {
  const query = createFakeQuery([initMessage(), resultMessage({ session_id: 'sess-forked' })])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const finish = await client.waitFor(frame => frame.type === 'finish')
  // A resume that forks after `init` is resumed from the fork, not from the init id.
  expect(finish.sessionArtifacts).toMatchObject({
    sessionId: 'sess-forked',
    sessionTranscriptPath: expect.stringMatching(/\/sess-forked\.jsonl$/),
  })
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
