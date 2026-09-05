import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { Host } from './harness'
import { sdkPermissionModeSchema } from '@pleaseai/harness-protocol'
import { afterEach, expect, it } from 'vitest'
import { DENY_BY_RUN_POLICY_MESSAGE } from '../src/permission-policy'
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
