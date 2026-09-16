import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { Host } from './harness'
import { sdkPermissionModeSchema } from '@amond-ai/harness-protocol/claude-code'
import { afterEach, expect, it } from 'vitest'
import { DENIED_BY_REVIEWER_MESSAGE, DENY_BY_RUN_POLICY_MESSAGE } from '../src/permission-policy'
import { connect, createFakeQuery, initMessage, startHost } from './harness'

let host: Host | undefined

afterEach(async () => {
  await host?.close()
  host = undefined
})

/** The `PreToolUse` hook the driver installed, called the way the SDK calls it. */
async function callPreToolUse(
  options: Options | undefined,
  input: { tool_name: string, tool_input: unknown },
): Promise<{
  hookSpecificOutput?: {
    permissionDecision?: string
    permissionDecisionReason?: string
  }
}> {
  const hook = options?.hooks?.PreToolUse?.[0]?.hooks?.[0]
  if (hook === undefined) {
    throw new Error('no PreToolUse hook installed')
  }
  return (await hook(
    input as never,
    undefined,
    { signal: new AbortController().signal },
  )) as never
}

/** Start a turn and hand back the `options` the driver called `query()` with. */
async function startAndCaptureOptions(
  start: Record<string, unknown>,
): Promise<Options> {
  const query = createFakeQuery([initMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)
  client.send({ type: 'start', prompt: 'do the thing', ...start })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )
  if (query.options === undefined) {
    throw new Error('query() was not called')
  }
  return query.options
}

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
