import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { Client, Host } from './harness'
import { connect, createFakeQuery, initMessage, startHost } from './harness'

/** The host a test started through `startAndConnect`, for its `afterEach` to close. */
export const hostRef: { current: Host | undefined } = { current: undefined }

/** The `PreToolUse` hook the driver installed, called the way the SDK calls it. */
export async function callPreToolUse(
  options: Options | undefined,
  input: { tool_name: string, tool_input: unknown },
): Promise<{
  hookSpecificOutput?: {
    permissionDecision?: string
    permissionDecisionReason?: string
    updatedInput?: Record<string, unknown>
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

/** Start a turn and hand back the `options` the driver called `query()` with, and the socket. */
export async function startAndConnect(
  start: Record<string, unknown>,
): Promise<{ options: Options, client: Client }> {
  const query = createFakeQuery([initMessage()])
  // A test may start several hosts; close the one this replaces, not only the last.
  await hostRef.current?.close()
  hostRef.current = await startHost({ query: query.fn })
  const client = await connect(hostRef.current)
  client.send({ type: 'start', prompt: 'do the thing', ...start })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )
  if (query.options === undefined) {
    throw new Error('query() was not called')
  }
  return { options: query.options, client }
}

/** Start a turn and hand back the `options` the driver called `query()` with. */
export async function startAndCaptureOptions(
  start: Record<string, unknown>,
): Promise<Options> {
  return (await startAndConnect(start)).options
}
