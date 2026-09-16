import type { Host } from './harness'
import { afterEach, expect, it, vi } from 'vitest'
import {
  agentMessageEvents,
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

it('runs the thread under the posture the schema was written for', async () => {
  const codex = createFakeCodex(successfulTurn())
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing', reasoningEffort: 'high' })
  await client.waitFor(frame => frame.type === 'finish')

  expect(codex.threadOptions).toMatchObject({
    // Load-bearing: `codexTurnHostFinishSchema` has no `deferredToolUse`
    // because a turn under this policy cannot park on a decision.
    approvalPolicy: 'never',
    // The sandbox is the isolation boundary, not the CLI.
    sandboxMode: 'danger-full-access',
    workingDirectory: '/workspace/repo',
    skipGitRepoCheck: true,
    modelReasoningEffort: 'high',
    webSearchMode: 'disabled',
  })
  client.close()
})

it('interrupts the turn and finishes it as interrupted', async () => {
  // No `turn.completed` in the script: the turn only ends because the interrupt
  // aborts the signal the SDK stream runs on.
  const codex = createFakeCodex([threadStarted(), ...agentMessageEvents('working')])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'text-end')

  client.send({ type: 'interrupt', reason: 'watchdog' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  expect(codex.runs[0]?.turnOptions?.signal?.aborted).toBe(true)
  expect(finish.stopped).toBe('interrupted')
  // Echoed back, because the client's own record of the stop it asked for is
  // not durable across a step that never committed.
  expect(finish.interruptedBy).toBe('watchdog')
  expect(client.frames.some(frame => frame.type === 'error')).toBe(false)
  client.close()
})

it('finishes an interrupted turn even when the stream ends instead of throwing', async () => {
  // The same stop against the gentler generator: the ending is the host's, not
  // the SDK's, so it does not depend on how the stream reacted to the abort.
  const codex = createFakeCodex(
    [threadStarted(), ...agentMessageEvents('working')],
    { onAbort: 'end' },
  )
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'text-end')

  client.send({ type: 'interrupt', reason: 'budget' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  expect(finish.stopped).toBe('interrupted')
  expect(finish.interruptedBy).toBe('budget')
  client.close()
})

it('leaves an abort without a finish, because it is a teardown and not a turn', async () => {
  const codex = createFakeCodex([threadStarted(), ...agentMessageEvents('working')])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'text-end')

  client.send({ type: 'abort' })
  // The turn settles back to `waiting`, which is what a second `start` proves —
  // and it proves it without asserting on the absence of a frame that has not
  // had time to arrive.
  codex.push(turnCompleted())
  client.send({ type: 'start', prompt: 'and again' })
  await client.waitFor(frame => frame.type === 'bridge-started' && (frame.seq as number) > 1)

  expect(client.frames.filter(frame => frame.type === 'finish')).toHaveLength(0)
  expect(client.frames.filter(frame => frame.type === 'error')).toHaveLength(0)
  client.close()
})

it('ends a failed turn on an error frame and not also on a finish', async () => {
  const codex = createFakeCodex([
    threadStarted(),
    { type: 'turn.failed', error: { message: 'the model went away' } },
  ])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('run')
  expect(error.error).toBe('the model went away')
  expect(error.journalPath).toBe(host.journalPath)

  /*
   * `finish` and `error` are alternative endings. Codex reports a failed turn
   * as an event rather than by throwing, so without the latch the turn would
   * be reported as failed *and* then finished.
   *
   * The second `start` is what makes that assertable: it only gets its
   * `bridge-started` once the first turn has settled back to `waiting`, so a
   * `finish` the first turn was about to send has already had its chance.
   */
  codex.push(threadStarted('thr-2'))
  codex.push(turnCompleted())
  client.send({ type: 'start', prompt: 'and again' })
  await client.waitFor(frame => frame.type === 'finish')

  expect(client.frames.filter(frame => frame.type === 'finish')).toHaveLength(1)
  client.close()
})

it('reports a stream that ended without a terminal event as a run-phase error', async () => {
  // The CLI child dying mid-turn: the iterable runs dry with no
  // `turn.completed`, and a `finish` here would call a truncated turn a clean
  // one.
  const codex = createFakeCodex([threadStarted(), ...agentMessageEvents('working')])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'text-end')

  codex.end()
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('run')
  expect(String(error.error)).toContain('without a terminal event')
  expect(client.frames.some(frame => frame.type === 'finish')).toBe(false)
  client.close()
})

it('reports a stream that threw as a run-phase error', async () => {
  const codex = createFakeCodex([
    threadStarted(),
    { type: 'error', message: 'codex exec exited with status 1' },
  ])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('run')
  expect(error.error).toBe('codex exec exited with status 1')
  expect(error.journalPath).toBe(host.journalPath)
  client.close()
})

it('resumes the thread the start named, and restarts when told to', async () => {
  const codex = createFakeCodex(successfulTurn())
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'first', resumeThreadId: 'thr-earlier' })
  await client.waitFor(frame => frame.type === 'finish')
  expect(codex.resumedId).toBe('thr-earlier')
  expect(codex.startThreadCount).toBe(0)

  // The thread this process is now on is resumed implicitly on the next turn…
  codex.push(turnCompleted())
  client.send({ type: 'start', prompt: 'second' })
  await client.waitFor(
    () => client.frames.filter(frame => frame.type === 'finish').length === 2,
  )
  expect(codex.resumedId).toBe('thr-1')

  // …unless the client asks for a fresh one.
  codex.push(threadStarted('thr-2'))
  codex.push(turnCompleted())
  client.send({ type: 'start', prompt: 'third', restartThread: true })
  await client.waitFor(
    () => client.frames.filter(frame => frame.type === 'finish').length === 3,
  )
  expect(codex.startThreadCount).toBe(1)
  client.close()
})

it('refuses a start carrying tools without opening a thread', async () => {
  const codex = createFakeCodex(successfulTurn())
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({
    type: 'start',
    prompt: 'do the thing',
    tools: [{ name: 'lookup' }],
  })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('start')
  expect(error.error).toContain('start.tools')
  expect(codex.called).toBe(false)
  client.close()
})

it('refuses a permission mode narrower than the one the thread runs', async () => {
  // Silently running `allow-reads` at `danger-full-access` is the failure this
  // refusal exists for: a turn with more access than it asked for.
  const codex = createFakeCodex(successfulTurn())
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing', permissionMode: 'allow-reads' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('start')
  expect(error.error).toContain('allow-reads')
  expect(codex.called).toBe(false)
  client.close()
})

it('accepts the permission mode the thread does run', async () => {
  const codex = createFakeCodex(successfulTurn())
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing', permissionMode: 'allow-all' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  expect(finish.stopped).toBe('completed')
  client.close()
})

it('refuses a start whose fields do not validate without opening a thread', async () => {
  const codex = createFakeCodex(successfulTurn())
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing', webSearch: 'yes' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.phase).toBe('start')
  expect(codex.called).toBe(false)
  client.close()
})

it('refuses a mid-turn user message rather than leaving it unanswered', async () => {
  const codex = createFakeCodex([threadStarted(), ...agentMessageEvents('working')])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'text-end')

  client.send({ type: 'user-message', messageId: 'm-1', text: 'and also this' })
  const response = await client.waitFor(
    frame => frame.type === 'user-message-response',
  )

  // Codex takes one prompt per turn, and the refusal arrives while that turn is
  // still running — the runtime would reject the message anyway when it closed
  // the queue, but not until the turn ended.
  expect(response).toMatchObject({ messageId: 'm-1', accepted: false })
  expect(client.frames.some(frame => frame.type === 'finish')).toBe(false)
  client.close()
})

it.each(['stop', 'destroy'])('aborts the running turn before %s exits the process', async (command) => {
  // Both commands exit the process, and the SDK spawns `codex exec` without
  // `detached`: a signal never aborted leaves the child orphaned and
  // `runStreamed`'s own cleanup unrun.
  const codex = createFakeCodex([threadStarted(), ...agentMessageEvents('working')])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'text-end')

  client.send({ type: command })
  await vi.waitFor(() => {
    expect(codex.runs[0]?.turnOptions?.signal?.aborted).toBe(true)
  })
  client.close()
})

it('answers an interrupt with no running turn on that socket alone', async () => {
  const codex = createFakeCodex(successfulTurn())
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'interrupt', reason: 'operator' })
  const error = await client.waitFor(frame => frame.type === 'error')

  expect(error.error).toBe('no running turn to interrupt')
  // A control frame, not an event: it consumes no `seq` and is not journaled.
  expect(error.seq).toBeUndefined()
  expect(await host.readJournal()).toHaveLength(0)
  client.close()
})
