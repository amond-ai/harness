import { sdkPermissionModeSchema } from '@amond-ai/harness-protocol/claude-code'
import { afterEach, expect, it } from 'vitest'
import { DENIED_BY_REVIEWER_MESSAGE, DENY_BY_RUN_POLICY_MESSAGE } from '../src/permission-policy'
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
