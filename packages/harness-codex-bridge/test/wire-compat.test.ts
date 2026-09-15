import type { Host } from './harness'
import {
  codexTurnHostOutboundMessageSchema,
  harnessV1BridgeOutboundMessageSchema,
} from '@amond-ai/harness-protocol/codex'
import { afterEach, expect, it } from 'vitest'
import {
  agentMessageEvents,
  commandExecutionEvents,
  connect,
  createFakeCodex,
  startHost,
  threadStarted,
  turnCompleted,
} from './harness'

let host: Host | undefined

afterEach(async () => {
  await host?.close()
  host = undefined
})

it('emits only frames the upstream outbound schema accepts', async () => {
  const codex = createFakeCodex([
    threadStarted(),
    ...commandExecutionEvents(),
    ...agentMessageEvents('hi'),
    turnCompleted(),
  ])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  // The host adds `seq` to every event, and `stopped`/`journalPath` to
  // `finish`. The vendored schemas are plain `z.object`s, so those pass — a
  // failure here is a frame whose *shape* upstream would reject.
  // `bridge-started` is the one frame upstream does not know (patch 18, in
  // `harness-bridge-runtime/UPSTREAM.md`): it is added, not reshaped, so it is
  // checked only against the client's union below.
  const upstreamFrames = client.frames.filter(frame => frame.type !== 'bridge-started')
  expect(rejectedBy(harnessV1BridgeOutboundMessageSchema, upstreamFrames)).toEqual([])
  expect(client.frames.some(frame => frame.type === 'bridge-started')).toBe(true)
  // And the same frames against the union the client actually validates with,
  // which keeps the added fields instead of stripping them. Checked here as
  // well as upstream because this is the only test that runs a real host: a
  // frame the client's schema rejects is a turn it cannot read the outcome of.
  expect(rejectedBy(codexTurnHostOutboundMessageSchema, client.frames)).toEqual([])
  expect(client.frames.length).toBeGreaterThan(0)
  client.close()
})

it('emits an interrupted finish both schemas still accept', async () => {
  // `stopped`, `interruptedBy` and `journalPath` are the three fields this
  // deployment adds to `finish`, and the added-field rule cuts both ways:
  // upstream must not *reject* the frame, and the client's union must keep the
  // values rather than strip them.
  const codex = createFakeCodex([threadStarted(), ...agentMessageEvents('working')])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'text-end')
  client.send({ type: 'interrupt', reason: 'budget' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  const upstreamFrames = client.frames.filter(frame => frame.type !== 'bridge-started')
  expect(rejectedBy(harnessV1BridgeOutboundMessageSchema, upstreamFrames)).toEqual([])
  expect(rejectedBy(codexTurnHostOutboundMessageSchema, client.frames)).toEqual([])
  expect(codexTurnHostOutboundMessageSchema.parse(finish)).toMatchObject({
    stopped: 'interrupted',
    interruptedBy: 'budget',
    journalPath: host.journalPath,
  })
  client.close()
})

it('emits a run-phase error both schemas still accept', async () => {
  const codex = createFakeCodex([
    threadStarted(),
    { type: 'turn.failed', error: { message: 'the model went away' } },
  ])
  host = await startHost({ codex: codex.factory })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const error = await client.waitFor(frame => frame.type === 'error')

  const upstreamFrames = client.frames.filter(frame => frame.type !== 'bridge-started')
  expect(rejectedBy(harnessV1BridgeOutboundMessageSchema, upstreamFrames)).toEqual([])
  expect(codexTurnHostOutboundMessageSchema.parse(error)).toMatchObject({
    phase: 'run',
    journalPath: host.journalPath,
  })
  client.close()
})

function rejectedBy(
  schema: { safeParse: (value: unknown) => { success: boolean, error?: { issues: unknown } } },
  frames: Array<Record<string, unknown> & { type: string }>,
): Array<{ type: string, issues: unknown }> {
  return frames
    .map(frame => ({ frame, result: schema.safeParse(frame) }))
    .filter(({ result }) => !result.success)
    .map(({ frame, result }) => ({ type: frame.type, issues: result.error?.issues }))
}
