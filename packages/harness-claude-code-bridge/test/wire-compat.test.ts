import type { Host } from './harness'
import { harnessV1BridgeOutboundMessageSchema } from '@pleaseai/harness-protocol'
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
  const rejected = client.frames
    .map(frame => ({
      frame,
      result: harnessV1BridgeOutboundMessageSchema.safeParse(frame),
    }))
    .filter(({ result }) => !result.success)
    .map(({ frame, result }) => ({
      type: frame.type,
      issues: result.error?.issues,
    }))

  expect(rejected).toEqual([])
  expect(client.frames.length).toBeGreaterThan(0)
  client.close()
})
