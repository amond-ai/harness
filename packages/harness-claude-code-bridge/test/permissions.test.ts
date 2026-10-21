import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { Frame } from './harness'
import { sdkPermissionModeSchema } from '@amond-ai/harness-protocol/claude-code'
import { afterEach, expect, it } from 'vitest'
import { DENIED_BY_REVIEWER_MESSAGE, DENY_BY_RUN_POLICY_MESSAGE } from '../src/permission-policy'
import { resultMessage } from './harness'
import { callPreToolUse, hostRef, startAndCaptureOptions, startAndConnect } from './pre-tool-use'

afterEach(async () => {
  await hostRef.current?.close()
  hostRef.current = undefined
})

it('denies through canUseTool without forwarding under approvalPolicy deny', async () => {
  const options = await startAndCaptureOptions({
    permissionMode: 'default',
    approvalPolicy: 'deny',
  })

  const decision = await options.canUseTool?.(
    'Bash',
    { command: 'rm -rf /' },
    { signal: new AbortController().signal, toolUseID: 'call-1' } as never,
  )

  expect(decision).toMatchObject({
    behavior: 'deny',
    message: DENY_BY_RUN_POLICY_MESSAGE,
  })
})

it('marks an approval-gated external MCP call dynamic, as the stream does', async () => {
  const { options, client } = await startAndConnect({ permissionMode: 'default', approvalPolicy: 'forward' })

  // Pends on the human's answer, which never comes: only the frames it emitted first matter.
  void options.canUseTool?.(
    'mcp__github__create_issue',
    { title: 'x' },
    { signal: new AbortController().signal, toolUseID: 'call-7' } as never,
  )
  const call = await client.waitFor(frame => frame.type === 'tool-call')

  expect(call).toMatchObject({
    toolCallId: 'call-7',
    toolName: 'mcp__github__create_issue',
    providerExecuted: true,
    dynamic: true,
  })
  await client.waitFor(frame => frame.type === 'tool-approval-request')
})

it('runs ListAgents as a read under allow-reads, without asking', async () => {
  const options = await startAndCaptureOptions({
    permissionMode: 'allow-reads',
    approvalPolicy: 'deny',
  })
  const call = (toolName: string, toolUseID: string): Promise<unknown> | undefined =>
    options.canUseTool?.(
      toolName,
      {},
      { signal: new AbortController().signal, toolUseID } as never,
    )

  expect(await call('ListAgents', 'call-1')).toMatchObject({ behavior: 'allow' })
  // An unlisted tool is still treated as an edit.
  expect(await call('SomeUnknownTool', 'call-2')).toMatchObject({ behavior: 'deny' })
})

it('forwards every SDK permission mode unchanged, auto included', async () => {
  for (const mode of sdkPermissionModeSchema.options) {
    const options = await startAndCaptureOptions({ permissionMode: mode })
    expect(options.permissionMode).toBe(mode)
    expect(options.allowDangerouslySkipPermissions ?? false).toBe(
      mode === 'bypassPermissions',
    )
  }
})

it('evaluates approvedRequests, then refuseTools, then deferTools', async () => {
  const options = await startAndCaptureOptions({
    permissionMode: 'bypassPermissions',
    refuseTools: ['WebFetch'],
    deferTools: ['Bash', 'mcp__github__*'],
    approvedRequests: [
      { id: 'req-1', name: 'Bash', input: { command: 'ls' } },
    ],
  })

  const refused = await callPreToolUse(options, {
    tool_name: 'WebFetch',
    tool_input: { url: 'https://example.com' },
  })
  expect(refused.hookSpecificOutput?.permissionDecision).toBe('deny')
  expect(refused.hookSpecificOutput?.permissionDecisionReason).toContain(
    'refuseTools',
  )

  const wildcard = await callPreToolUse(options, {
    tool_name: 'mcp__github__create_issue',
    tool_input: {},
  })
  expect(wildcard.hookSpecificOutput?.permissionDecision).toBe('defer')

  // The approval beats the defer rule that matched the same tool...
  const approved = await callPreToolUse(options, {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  })
  expect(approved.hookSpecificOutput?.permissionDecision).toBe('allow')
  expect(approved.hookSpecificOutput?.permissionDecisionReason).toContain(
    'req-1',
  )

  // ...exactly once: an answer authorizes one request, not the tool.
  const second = await callPreToolUse(options, {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  })
  expect(second.hookSpecificOutput?.permissionDecision).toBe('defer')
})

it('denies a contradicted call and voids the approval that contradicted it', async () => {
  const options = await startAndCaptureOptions({
    permissionMode: 'bypassPermissions',
    deferTools: ['Bash'],
    // The same call on both lists — a contradiction the Worker should never send. Denying is
    // the only reading of it that cannot turn a mistake into an unauthorized tool call.
    approvedRequests: [{ id: 'req-1', name: 'Bash', input: { command: 'ls' } }],
    deniedRequests: [
      { id: 'req-1', name: 'Bash', input: { command: 'ls' }, reason: 'not this one' },
    ],
  })

  const denied = await callPreToolUse(options, {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  })
  expect(denied.hookSpecificOutput?.permissionDecision).toBe('deny')
  expect(denied.hookSpecificOutput?.permissionDecisionReason).toBe(
    'not this one (request req-1)',
  )

  // Both entries are consumed, not just the denial. An agent told "no" is free to try the same
  // call again, and a surviving approval would let that retry through on the half of the
  // contradiction the first evaluation skipped — so the retry falls back to the defer rule that
  // asked the question in the first place.
  const second = await callPreToolUse(options, {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  })
  expect(second.hookSpecificOutput?.permissionDecision).toBe('defer')
})

it('denies with a default reason when the human gave none', async () => {
  const options = await startAndCaptureOptions({
    permissionMode: 'bypassPermissions',
    deferTools: ['Bash'],
    deniedRequests: [{ id: 'req-2', name: 'Bash', input: { command: 'ls' } }],
  })

  const denied = await callPreToolUse(options, {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
  })
  expect(denied.hookSpecificOutput?.permissionDecisionReason).toBe(
    `${DENIED_BY_REVIEWER_MESSAGE} (request req-2)`,
  )
})

it('resumes the session the start named, as the SDK option', async () => {
  const options = await startAndCaptureOptions({ sessionId: 'sess-worker-1' })

  expect(options.sessionId).toBe('sess-worker-1')
})

it('forwards the subagent stream options as the SDK options', async () => {
  const options = await startAndCaptureOptions({ agentProgressSummaries: true, forwardSubagentText: false })

  expect(options.agentProgressSummaries).toBe(true)
  expect(options.forwardSubagentText).toBe(false)
})

it('filters AskUserQuestion under its harness name, askUserQuestions', async () => {
  const allowed = await startAndCaptureOptions({
    builtinToolFiltering: { mode: 'allow', toolNames: ['read', 'askUserQuestions'] },
  })
  expect(allowed.tools).toEqual(['Read', 'AskUserQuestion'])
  expect(allowed.disallowedTools).not.toContain('AskUserQuestion')
  await hostRef.current?.close()

  const denied = await startAndCaptureOptions({
    builtinToolFiltering: { mode: 'deny', toolNames: ['askUserQuestions'] },
  })
  expect(denied.disallowedTools).toEqual(['AskUserQuestion'])
})

it('bypasses without canUseTool, and the run policy still bites through the hook', async () => {
  // The SDK mode, the harness mode that maps onto it, and no mode at all (`allow-all`).
  for (const permissionMode of ['bypassPermissions', 'allow-all', undefined]) {
    const options = await startAndCaptureOptions({
      ...(permissionMode === undefined ? {} : { permissionMode }),
      refuseTools: ['WebFetch'],
      deferTools: ['Bash'],
    })
    expect(options.permissionMode).toBe('bypassPermissions')
    expect(options.allowDangerouslySkipPermissions).toBe(true)
    expect(options.canUseTool).toBeUndefined()
    expect(options.permissionPromptToolName).toBe('stdio')

    const refused = await callPreToolUse(options, { tool_name: 'WebFetch', tool_input: {} })
    expect(refused.hookSpecificOutput?.permissionDecision).toBe('deny')
    const deferred = await callPreToolUse(options, { tool_name: 'Bash', tool_input: { command: 'ls' } })
    expect(deferred.hookSpecificOutput?.permissionDecision).toBe('defer')
    await hostRef.current?.close()
    hostRef.current = undefined
  }
})

const PWD = { command: 'pwd' }

/** One response calling `Bash` once per id, in parallel. */
function bashCalls(...ids: string[]): Record<string, unknown> {
  return {
    type: 'assistant',
    message: { content: ids.map(id => ({ type: 'tool_use', id, name: 'Bash', input: PWD })) },
  }
}

function bashResults(...ids: string[]): Record<string, unknown> {
  return {
    type: 'user',
    message: { content: ids.map(id => ({ type: 'tool_result', tool_use_id: id, content: '/work' })) },
  }
}

const MESSAGE_START = { type: 'stream_event', event: { type: 'message_start' } }
const MESSAGE_STOP = { type: 'stream_event', event: { type: 'message_stop' } }

/** Ask `canUseTool` about one `Bash` call, the way the SDK does. */
function askApproval(options: Options, toolUseID: string): Promise<unknown> | undefined {
  return options.canUseTool?.('Bash', PWD, { signal: new AbortController().signal, toolUseID } as never)
}

function finishReasons(frames: Frame[]): Array<string | undefined> {
  return frames
    .filter(frame => frame.type === 'finish-step')
    .map(frame => (frame.finishReason as { raw?: string }).raw)
}

it.each(['before', 'after'] as const)(
  'emits one tool-call per call when canUseTool runs %s the assistant message reports it',
  async (ordering) => {
    const { options, client, query } = await startAndConnect({ permissionMode: 'default', approvalPolicy: 'forward' })

    query.push(MESSAGE_START)
    if (ordering === 'after') {
      query.push(bashCalls('first', 'second'))
      await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === 'second')
    }
    const decisions = ['first', 'second'].map(id => askApproval(options, id))
    await client.waitFor(frame => frame.type === 'tool-approval-request' && frame.approvalId === 'second')
    if (ordering === 'before') {
      query.push(bashCalls('first', 'second'))
    }
    query.push(MESSAGE_STOP)
    for (const id of ['first', 'second']) {
      client.send({ type: 'tool-approval-response', approvalId: id, approved: true })
    }
    await Promise.all(decisions)
    query.push(bashResults('first', 'second'))
    query.push(resultMessage())
    await client.waitFor(frame => frame.type === 'finish')

    expect(client.frames.filter(frame => frame.type === 'tool-call').map(frame => frame.toolCallId))
      .toEqual(['first', 'second'])
    expect(client.frames.filter(frame => frame.type === 'tool-approval-request').map(frame => frame.approvalId))
      .toEqual(['first', 'second'])
  },
)

it('pauses the step on the host again for an approval asked after the first resolved', async () => {
  const { options, client, query } = await startAndConnect({ permissionMode: 'default', approvalPolicy: 'forward' })

  query.push(MESSAGE_START)
  query.push(bashCalls('first', 'second'))
  await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === 'second')
  // The CLI dispatches the response's calls one at a time: `second` queues behind `first`'s prompt.
  const first = askApproval(options, 'first')
  await client.waitFor(frame => frame.type === 'tool-approval-request' && frame.approvalId === 'first')
  query.push(MESSAGE_STOP)
  await client.waitFor(frame => frame.type === 'finish-step')
  client.send({ type: 'tool-approval-response', approvalId: 'first', approved: true })
  expect(await first).toEqual({ behavior: 'allow', updatedInput: PWD, toolUseID: 'first' })

  const second = askApproval(options, 'second')
  const request = await client.waitFor(frame => frame.type === 'tool-approval-request' && frame.approvalId === 'second')
  const pause = await client.waitFor(frame => frame.type === 'finish-step' && frame.seq! > request.seq!)
  client.send({ type: 'tool-approval-response', approvalId: 'second', approved: false, reason: 'Not allowed' })
  expect(await second).toEqual({ behavior: 'deny', message: 'Not allowed', toolUseID: 'second' })
  query.push(bashResults('first', 'second'))
  query.push(resultMessage())
  await client.waitFor(frame => frame.type === 'finish')

  expect(pause.finishReason).toEqual({ unified: 'tool-calls', raw: 'host-input' })
  // One pause per approval, then the step's own end once both calls have their results.
  expect(finishReasons(client.frames)).toEqual(['host-input', 'host-input', 'stop'])
})

it('neither pends nor pauses the step on the host under approvalPolicy deny', async () => {
  const { options, client, query } = await startAndConnect({ permissionMode: 'default', approvalPolicy: 'deny' })

  query.push(MESSAGE_START)
  query.push(bashCalls('first'))
  await client.waitFor(frame => frame.type === 'tool-call' && frame.toolCallId === 'first')
  expect(await askApproval(options, 'first')).toEqual({
    behavior: 'deny',
    message: DENY_BY_RUN_POLICY_MESSAGE,
    toolUseID: 'first',
  })
  query.push(MESSAGE_STOP)
  query.push({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'first', content: DENY_BY_RUN_POLICY_MESSAGE, is_error: true }] },
  })
  query.push(resultMessage())
  await client.waitFor(frame => frame.type === 'finish')

  expect(client.frames.some(frame => frame.type === 'tool-approval-request')).toBe(false)
  expect(finishReasons(client.frames)).toEqual(['stop'])
})
