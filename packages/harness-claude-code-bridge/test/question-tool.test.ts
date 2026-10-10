import type { Client } from './harness'
import { afterEach, expect, it } from 'vitest'
import { connect, createFakeQuery, initMessage, resultMessage, startHost } from './harness'
import { callPreToolUse, hostRef, startAndConnect } from './pre-tool-use'

afterEach(async () => {
  await hostRef.current?.close()
  hostRef.current = undefined
})

const QUESTIONS = [{
  question: 'Which fruit?',
  header: 'Fruit',
  options: [{ label: 'apple', description: '' }, { label: 'pear', description: '' }],
  multiSelect: false,
}]

/** An `AskUserQuestion` call as the SDK hands it to the `PreToolUse` hook. */
function questionCall(toolUseId: string): Record<string, unknown> {
  return {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { questions: QUESTIONS },
    tool_use_id: toolUseId,
  }
}

it('asks the host to answer a question under approvalPolicy forward, and runs it with the answers', async () => {
  const { options, client } = await startAndConnect({ approvalPolicy: 'forward' })

  const decision = callPreToolUse(options, questionCall('toolu_q1') as never)
  const call = await client.waitFor(frame => frame.type === 'tool-call')
  expect(call).toMatchObject({
    toolCallId: 'toolu_q1',
    toolName: 'askUserQuestions',
    nativeName: 'AskUserQuestion',
    providerExecuted: false,
  })
  expect(JSON.parse(call.input as string)).toMatchObject({
    questions: [{ id: 'question-1', question: 'Which fruit?', options: [{ id: 'option-1' }, { id: 'option-2' }] }],
  })

  client.send({
    type: 'tool-result',
    toolCallId: 'toolu_q1',
    output: { action: 'answered', answers: { 'question-1': { optionIds: ['option-2'] } } },
  })
  expect((await decision).hookSpecificOutput).toMatchObject({
    permissionDecision: 'allow',
    updatedInput: { questions: QUESTIONS, answers: { 'Which fruit?': 'pear' } },
  })
})

it('denies a question whose host answer the questions-tool schema refuses', async () => {
  const { options, client } = await startAndConnect({ approvalPolicy: 'forward' })
  const malformed: unknown[] = [
    null,
    'pear',
    { action: 'answered' },
    { action: 'answered', answers: { 'question-1': { freeform: 'pear' } } },
  ]
  for (const [index, output] of malformed.entries()) {
    const toolUseId = `toolu_bad${index}`
    const decision = callPreToolUse(options, questionCall(toolUseId) as never)
    await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === toolUseId)
    client.send({ type: 'tool-result', toolCallId: toolUseId, output })
    expect((await decision).hookSpecificOutput).toMatchObject({
      permissionDecision: 'deny',
      permissionDecisionReason: 'The questions were not answered.',
    })
  }
})

/** Ask `QUESTIONS`, answer with `answer`, and hand back what the CLI is told to run with. */
async function askAndAnswer(answer: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
  const { options, client } = await startAndConnect({ approvalPolicy: 'forward' })
  const decision = callPreToolUse(options, questionCall('toolu_a') as never)
  await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === 'toolu_a')
  client.send({
    type: 'tool-result',
    toolCallId: 'toolu_a',
    output: { action: 'answered', answers: { 'question-1': answer } },
  })
  const outcome = await decision
  expect(outcome.hookSpecificOutput?.permissionDecision).toBe('allow')
  const answers = (outcome.hookSpecificOutput?.updatedInput as { answers: Record<string, string> }).answers
  await hostRef.current?.close()
  hostRef.current = undefined
  return answers
}

it('composes an answer from the selected label and the free text, and drops a question with neither', async () => {
  expect(await askAndAnswer({ optionIds: ['option-2'], freeform: '' })).toEqual({ 'Which fruit?': 'pear' })
  expect(await askAndAnswer({ optionIds: ['option-2'], freeform: ' note ' })).toEqual({ 'Which fruit?': 'pear, note' })
  expect(await askAndAnswer({ optionIds: [], freeform: 'kiwi' })).toEqual({ 'Which fruit?': 'kiwi' })
  expect(await askAndAnswer({ optionIds: ['option-9', 'nope'] })).toEqual({})
})

it('leaves a malformed question to the CLI, with one tool-call so its result has a call', async () => {
  const { options, client } = await startAndConnect({ approvalPolicy: 'forward' })
  const malformed: unknown[] = [
    {},
    { questions: 'which fruit?' },
    { questions: [] },
    { questions: [null] },
    { questions: [{ header: 'Fruit' }] },
    { questions: [{ question: 'Which fruit?', options: [{ description: '' }] }] },
    { questions: [{ question: 'Which fruit?', options: 'apple' }] },
    { questions: [{ question: '' }] },
    { questions: [{ question: 'Which fruit?', options: [{ label: '' }] }] },
    // Optional fields of a type the questions-tool schema refuses: forwarded, the host would
    // be handed a tool input it cannot parse.
    { questions: [{ question: 'Which fruit?', header: 5 }] },
    { questions: [{ question: 'Which fruit?', multiSelect: 'yes' }] },
    { questions: [{ question: 'Which fruit?', options: [{ label: 'Apple', description: 5 }] }] },
    { questions: [{ question: 'Which fruit?', options: [{ label: 'Apple', preview: {} }] }] },
  ]
  for (const [index, toolInput] of malformed.entries()) {
    const toolUseId = `toolu_m${index}`
    const outcome = await callPreToolUse(options, {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      tool_input: toolInput,
      tool_use_id: toolUseId,
    } as never)
    expect(outcome.hookSpecificOutput).toBeUndefined()
    await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === toolUseId)
    await sync(client, `sync-m${index}`)
    const calls = client.frames.filter(frame => frame.type === 'tool-call' && frame.toolCallId === toolUseId)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ toolName: 'askUserQuestions', providerExecuted: true })
  }
})

it('takes an answer the host sent before it was asked, matched on the question', async () => {
  // Under another id — the one a host saw on an earlier attempt of the same call.
  const { options, client } = await startAndConnect({ approvalPolicy: 'forward' })
  client.send({
    type: 'tool-result',
    toolCallId: 'toolu_earlier',
    output: { action: 'declined' },
    toolResult: {
      type: 'tool-result',
      toolCallId: 'toolu_earlier',
      toolName: 'askUserQuestions',
      output: { type: 'json', value: { action: 'declined' } },
      providerOptions: { 'claude-code': { nativeRequest: { questions: QUESTIONS } } },
    },
  })
  // A round trip behind it on the same socket, so the answer is buffered before the hook asks:
  // the bridge handles one socket's frames in order and refuses this one on that socket alone.
  client.send({ type: 'interrupt', reason: 'sync' })
  await client.waitFor(frame => frame.type === 'error' && String(frame.error).includes('sync'))

  const decision = await callPreToolUse(options, questionCall('toolu_q2') as never)
  expect(decision.hookSpecificOutput).toMatchObject({
    permissionDecision: 'deny',
    permissionDecisionReason: 'The user declined the questions.',
  })
})

/*
 * The run policy decides before the question flow, in that order and in one hook: a question it
 * decided — or one no host is there to answer — never parks the CLI on a host answer. Each call
 * below resolves without a `tool-result` being sent, and is reported as the runtime's own call.
 */
it('lets the run policy decide a question before the host is asked', async () => {
  const cases: Array<{ start: Record<string, unknown>, decision: string | undefined }> = [
    { start: { approvalPolicy: 'forward', deferTools: ['AskUserQuestion'] }, decision: 'defer' },
    { start: { approvalPolicy: 'forward', refuseTools: ['AskUserQuestion'] }, decision: 'deny' },
    {
      start: {
        approvalPolicy: 'forward',
        deferTools: ['AskUserQuestion'],
        approvedRequests: [{ id: 'req-q', name: 'AskUserQuestion', input: { questions: QUESTIONS }, updatedInput: { questions: QUESTIONS, answers: { 'Which fruit?': 'apple' } } }],
      },
      decision: 'allow',
    },
    {
      start: {
        approvalPolicy: 'forward',
        deniedRequests: [{ id: 'req-q', name: 'AskUserQuestion', input: { questions: QUESTIONS } }],
      },
      decision: 'deny',
    },
    // Nobody to answer: no decision from the hook, and the normal pipeline takes the call.
    { start: { approvalPolicy: 'deny' }, decision: undefined },
  ]
  for (const { start, decision } of cases) {
    const { options, client } = await startAndConnect(start)
    const outcome = await callPreToolUse(options, questionCall('toolu_q3') as never)
    expect(outcome.hookSpecificOutput?.permissionDecision).toBe(decision)
    const call = await client.waitFor(frame => frame.type === 'tool-call')
    expect(call).toMatchObject({ toolCallId: 'toolu_q3', toolName: 'askUserQuestions', providerExecuted: true })
    await hostRef.current?.close()
    hostRef.current = undefined
  }
})

/** An answer to `QUESTIONS` that carries the request it answers, so `matches` can take it. */
function questionAnswer(toolCallId: string): Record<string, unknown> {
  const output = { action: 'answered', answers: { 'question-1': { optionIds: ['option-1'] } } }
  return {
    type: 'tool-result',
    toolCallId,
    output,
    toolResult: {
      type: 'tool-result',
      toolCallId,
      toolName: 'askUserQuestions',
      output: { type: 'json', value: output },
      providerOptions: { 'claude-code': { nativeRequest: { questions: QUESTIONS } } },
    },
  }
}

/** A round trip the bridge refuses on this socket alone: every frame sent before it was handled. */
async function sync(client: Client, tag: string): Promise<void> {
  client.send({ type: 'interrupt', reason: tag })
  await client.waitFor(frame => frame.type === 'error' && String(frame.error).includes(tag))
}

/** Whether `promise` has settled by now. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false
  void promise.then(() => {
    settled = true
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  return settled
}

it('drops a retransmitted answer, so an identical new question in the same turn is asked again', async () => {
  const { options, client } = await startAndConnect({ approvalPolicy: 'forward' })

  const first = callPreToolUse(options, questionCall('toolu_q1') as never)
  await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === 'toolu_q1')
  client.send(questionAnswer('toolu_q1'))
  expect((await first).hookSpecificOutput?.permissionDecision).toBe('allow')

  // The same answer again, then the same question under a new id.
  client.send(questionAnswer('toolu_q1'))
  await sync(client, 'sync-a')
  const second = callPreToolUse(options, questionCall('toolu_q2') as never)
  await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === 'toolu_q2')
  expect(await hasSettled(second)).toBe(false)

  client.send({ type: 'abort' })
  expect((await second).hookSpecificOutput?.permissionDecision).toBe('deny')
})

it('buffers a duplicated answer once, so it cannot answer a second identical question', async () => {
  const { options, client } = await startAndConnect({ approvalPolicy: 'forward' })

  client.send(questionAnswer('toolu_dup'))
  client.send(questionAnswer('toolu_dup'))
  await sync(client, 'sync-dup')

  const first = await callPreToolUse(options, questionCall('toolu_q1') as never)
  expect(first.hookSpecificOutput?.permissionDecision).toBe('allow')
  const second = callPreToolUse(options, questionCall('toolu_q2') as never)
  await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === 'toolu_q2')
  expect(await hasSettled(second)).toBe(false)

  client.send({ type: 'abort' })
  expect((await second).hookSpecificOutput?.permissionDecision).toBe('deny')
})

it('does not let a turn\'s buffered answer answer an identical question in the next turn', async () => {
  const query = createFakeQuery([initMessage()])
  hostRef.current = await startHost({ query: query.fn })
  const client = await connect(hostRef.current)
  client.send({ type: 'start', prompt: 'first', approvalPolicy: 'forward' })
  await client.waitFor(frame => frame.type === 'raw')

  // Buffered in turn 1: nothing asked for it.
  client.send(questionAnswer('toolu_early'))
  await sync(client, 'sync-b')
  query.push(resultMessage())
  await client.waitFor(frame => frame.type === 'finish')

  query.push(initMessage())
  client.send({ type: 'start', prompt: 'second', approvalPolicy: 'forward' })
  await client.waitFor(() => client.frames.filter(frame => frame.type === 'raw' && (frame.rawValue as { type: string }).type === 'system').length === 2)

  const decision = callPreToolUse(query.options, questionCall('toolu_q2') as never)
  await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === 'toolu_q2')
  await sync(client, 'sync-c')
  expect(await hasSettled(decision)).toBe(false)

  client.send({ type: 'abort' })
  expect((await decision).hookSpecificOutput?.permissionDecision).toBe('deny')
})

it('settles a parked question on abort, and keeps its late answer from the next turn', async () => {
  const query = createFakeQuery([initMessage()])
  hostRef.current = await startHost({ query: query.fn, abortFallbackMs: 50 })
  const client = await connect(hostRef.current)
  client.send({ type: 'start', prompt: 'first', approvalPolicy: 'forward' })
  await client.waitFor(frame => frame.type === 'raw')

  const parked = callPreToolUse(query.options, questionCall('toolu_q1') as never)
  await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === 'toolu_q1')
  client.send({ type: 'abort' })
  // Settled as a refusal, never as an answer: the hook unblocks and denies.
  expect((await parked).hookSpecificOutput).toMatchObject({
    permissionDecision: 'deny',
    permissionDecisionReason: 'the turn was aborted before the host answered',
  })
  await client.waitFor(frame => frame.type === 'error' && frame.phase === 'run')

  query.push(initMessage())
  client.send({ type: 'start', prompt: 'second', approvalPolicy: 'forward' })
  await client.waitFor(() => client.frames.filter(frame => frame.type === 'raw' && (frame.rawValue as { type: string }).type === 'system').length === 2)
  const replacement = callPreToolUse(query.options, questionCall('toolu_q2') as never)
  await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === 'toolu_q2')

  // The aborted question's answer arrives late: it must not answer the replacement.
  client.send(questionAnswer('toolu_q1'))
  await sync(client, 'sync-d')
  expect(await hasSettled(replacement)).toBe(false)

  client.send(questionAnswer('toolu_q2'))
  expect((await replacement).hookSpecificOutput?.permissionDecision).toBe('allow')
})
