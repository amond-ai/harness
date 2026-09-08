import type { Host } from './harness'
import { harnessV1BridgeOutboundMessageSchema, turnHostOutboundMessageSchema } from '@amond-ai/harness-protocol'
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

it('emits only frames the upstream outbound schema accepts', async () => {
  const query = createFakeQuery([
    initMessage(),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  // The host adds `seq` to every event, and `stopped`/`sessionArtifacts` to
  // `finish`. The vendored schemas are plain `z.object`s, so those pass — a
  // failure here is a frame whose *shape* upstream would reject.
  // `bridge-started` is the one frame upstream does not know (UPSTREAM.md patch 18): it is
  // added, not reshaped, so it is checked only against the Worker's union below.
  const upstreamFrames = client.frames.filter(frame => frame.type !== 'bridge-started')
  expect(rejectedBy(harnessV1BridgeOutboundMessageSchema, upstreamFrames)).toEqual([])
  expect(client.frames.some(frame => frame.type === 'bridge-started')).toBe(true)
  // And the same frames against the union the Worker actually validates with, which keeps
  // the added fields instead of stripping them (`protocol.ts`). Checked here as well as
  // upstream because this is the only test that runs a real host: a frame the Worker's
  // schema rejects is a turn it cannot read the outcome of.
  expect(rejectedBy(turnHostOutboundMessageSchema, client.frames)).toEqual([])
  expect(client.frames.length).toBeGreaterThan(0)
  client.close()
})

it('emits an interrupted finish both schemas still accept', async () => {
  // The echoed `interruptedBy` is one more added field, so it gets the same check the others
  // do: upstream must not *reject* the frame, and the Worker's union must keep the value.
  const query = createFakeQuery([initMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(
    frame => frame.type === 'raw'
      && (frame.rawValue as { type: string }).type === 'system',
  )
  client.send({ type: 'interrupt', reason: 'budget' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  const upstreamFrames = client.frames.filter(frame => frame.type !== 'bridge-started')
  expect(rejectedBy(harnessV1BridgeOutboundMessageSchema, upstreamFrames)).toEqual([])
  expect(rejectedBy(turnHostOutboundMessageSchema, client.frames)).toEqual([])
  expect(turnHostOutboundMessageSchema.parse(finish))
    .toMatchObject({ stopped: 'interrupted', interruptedBy: 'budget' })
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
