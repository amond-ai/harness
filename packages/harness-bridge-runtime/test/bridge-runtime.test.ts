/**
 * The runtime's own claims, proved without an agent.
 *
 * Every case here is about the transport this package now *is*: the token gate, the `seq`
 * counter, the disk-first journal, the replay, and the four control commands. They were all
 * reachable before only through `harness-claude-code-bridge`'s Agent SDK fake, which meant a
 * regression in the runtime and a regression in the Claude adapter failed the same test and
 * read the same way. Duplicating a few of them here is deliberate: these are the unit half.
 */
import type { Frame } from './ws-client'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { interruptReasonSchema } from '@amond-ai/harness-protocol'
import { afterEach, expect, it } from 'vitest'
import { INTERRUPT_REASONS, runBridge } from '../src/index'
import { connect, createFakeTurn, freePort, startRuntime } from './ws-client'

let open: Array<{ close: () => Promise<void> }> = []

afterEach(async () => {
  for (const runtime of open) {
    await runtime.close()
  }
  open = []
})

async function runtimeWith(turn: ReturnType<typeof createFakeTurn>): ReturnType<typeof startRuntime> {
  const runtime = await startRuntime({ onStart: turn.onStart })
  open.push(runtime)
  return runtime
}

/*
 * Patch 15's claim is two halves, and the half the Claude suite proves is the easier one: that
 * `runBridge` rejects. The load-bearing half is that it rejected *before it bound* — upstream
 * defaults the expected token to `''`, which authorizes a client sending an empty
 * `agent_bridge_token` on a `0.0.0.0` listener, so a refusal that still left a listening socket
 * behind would be no fix at all. Binding the same port again is what proves there was none.
 */
it('refuses a tokenless start before it binds the port', async () => {
  const port = await freePort()
  const inherited = process.env.BRIDGE_CHANNEL_TOKEN
  delete process.env.BRIDGE_CHANNEL_TOKEN

  try {
    await expect(runBridge({
      bridgeType: 'test',
      bridgeStateDir: await mkdtemp(join(tmpdir(), 'bridge-runtime-test-')),
      port,
      onStart: () => Promise.resolve(),
      onExit: () => {},
    })).rejects.toThrow('bridge channel token is required')

    // The port is still free, which is the whole point: nothing bound it.
    const second = await runBridge({
      bridgeType: 'test',
      bridgeStateDir: await mkdtemp(join(tmpdir(), 'bridge-runtime-test-')),
      port,
      token: 'a-token',
      onStart: () => Promise.resolve(),
      onExit: () => {},
    })
    expect(second.port).toBe(port)
    await second.close()
  }
  finally {
    if (inherited !== undefined) {
      process.env.BRIDGE_CHANNEL_TOKEN = inherited
    }
  }
})

it('greets an authorized socket with its state and seq, and closes an unauthorized one', async () => {
  const turn = createFakeTurn()
  const runtime = await runtimeWith(turn)

  const client = await connect(runtime)
  const hello = await client.waitFor(frame => frame.type === 'bridge-hello')
  expect(hello).toMatchObject({ type: 'bridge-hello', state: 'waiting', lastSeq: 0 })

  const rejected = await connect(runtime, { token: 'wrong' })
  await expect(rejected.closed).resolves.toBe(1008)
  expect(rejected.frames).toEqual([])
})

/*
 * `bridge-started` (patch 18) is the runtime's own acknowledgement, emitted the moment it enters
 * `running` rather than when the agent first speaks — so it is `seq: 1` of every turn, and a
 * case with no agent at all is the honest place to assert that.
 */
it('acknowledges a start as seq 1 and journals every frame but the live-only one', async () => {
  const turn = createFakeTurn()
  const runtime = await runtimeWith(turn)
  const client = await connect(runtime)
  await client.waitFor(frame => frame.type === 'bridge-hello')

  client.send({ type: 'start', prompt: 'go' })
  const bridgeTurn = await turn.started

  bridgeTurn.emit({ type: 'text-start', id: 'a' })
  bridgeTurn.emit({ type: 'text-delta', id: 'a', delta: 'hi' }, { journal: false })
  bridgeTurn.emit({ type: 'text-end', id: 'a' })
  await client.waitFor(frame => frame.type === 'text-end')
  await bridgeTurn.flush()

  const started = client.frames.find(frame => frame.type === 'bridge-started')
  expect(started?.seq).toBe(1)
  expect(client.frames.filter(f => f.seq !== undefined).map(f => f.seq)).toEqual([1, 2, 3, 4])

  // The live-only frame took a `seq` in order but never reached the journal.
  const journalled = await runtime.readJournal()
  expect(journalled.map(frame => [frame.seq, frame.type])).toEqual([
    [1, 'bridge-started'],
    [2, 'text-start'],
    [4, 'text-end'],
  ])
})

/*
 * Patch 11: a `resume` arriving while frames sit on the journal chain made `replay` and the
 * chain each send them. The runtime claims every `seq` up to the counter it snapshots before it
 * yields, so the chain skips those and the replay delivers them itself, once, in order. Today
 * this is only covered through the Claude adapter.
 */
it('delivers every frame exactly once across a resume', async () => {
  const turn = createFakeTurn()
  const runtime = await runtimeWith(turn)
  const first = await connect(runtime)
  await first.waitFor(frame => frame.type === 'bridge-hello')

  first.send({ type: 'start', prompt: 'go' })
  const bridgeTurn = await turn.started
  await first.waitFor(frame => frame.type === 'bridge-started')

  // The second socket is open *before* the frames are emitted, so the resume below lands while
  // their appends are still queued on the journal chain — the window the double-delivery lived
  // in. Connecting afterwards would let every append settle first and prove nothing.
  const second = await connect(runtime)
  await second.waitFor(frame => frame.type === 'bridge-hello')

  // Enough frames, each large enough, that their appends cannot all settle inside the loopback
  // round trip the `resume` below takes: with only a handful the chain drains first and the test
  // proves nothing. Verified by reintroducing the patch-11 bug, which this count catches.
  const FRAMES = 400
  const chunk = 'x'.repeat(512)
  for (let index = 0; index < FRAMES; index++) {
    bridgeTurn.emit({ type: 'text-delta', id: 'a', delta: `${index}:${chunk}` })
  }
  second.send({ type: 'resume', lastSeenEventId: 1 })

  const lastSeq = FRAMES + 1
  await second.waitFor(frame => frame.seq === lastSeq)

  /*
   * `stop`, and then the socket's own close, is the settle point — not `flush()`, and not the
   * arrival of the last `seq`. Both of those are reached while a duplicate batch can still be in
   * flight, so a count taken there passes against the patch-11 bug: measured at 400 frames with
   * the fix reverted, the tail arrived after the assertion and the suite stayed green. The
   * runtime closes this socket only after `flushPendingEventsToDisk`, so its close is the first
   * moment every queued send has actually gone out.
   */
  second.send({ type: 'stop' })
  await second.closed

  const delivered = second.frames.filter(frame => frame.seq !== undefined).map(frame => frame.seq)
  expect(new Set(delivered).size).toBe(delivered.length)
  expect(delivered).toEqual(Array.from({ length: FRAMES }, (_, index) => index + 2))
})

/*
 * Patch 12: upstream accepts a second `start` and lets both turns interleave frames on one
 * stream. The runtime answers it on the sending socket alone — no `seq`, so it is not on the
 * event stream — and leaves the running turn untouched.
 */
it('refuses a second start while a turn is running and leaves the first alone', async () => {
  const turn = createFakeTurn()
  const runtime = await runtimeWith(turn)
  const client = await connect(runtime)
  await client.waitFor(frame => frame.type === 'bridge-hello')

  client.send({ type: 'start', prompt: 'first' })
  const bridgeTurn = await turn.started
  await client.waitFor(frame => frame.type === 'bridge-started')

  client.send({ type: 'start', prompt: 'second' })
  const refusal = await client.waitFor(frame => frame.type === 'error')
  expect(refusal).toMatchObject({ phase: 'start', error: 'a bridge turn is already running' })
  expect(refusal.seq).toBeUndefined()
  expect(turn.callCount).toBe(1)

  // The first turn still owns the stream.
  bridgeTurn.emit({ type: 'text-start', id: 'a' })
  await expect(client.waitFor(frame => frame.type === 'text-start')).resolves.toMatchObject({ seq: 2 })
})

it('answers stop with the adapter data and exits, and destroy with neither', async () => {
  const stopped = await startRuntime({
    onStart: () => Promise.resolve(),
    onStop: () => ({ threadId: 'thr_1' }),
  })
  open.push(stopped)
  const stopClient = await connect(stopped)
  await stopClient.waitFor(frame => frame.type === 'bridge-hello')
  stopClient.send({ type: 'stop' })
  await expect(stopClient.waitFor(frame => frame.type === 'bridge-stop')).resolves.toMatchObject({
    data: { threadId: 'thr_1' },
  })
  await expect(stopped.exited).resolves.toBeUndefined()

  let destroyed = false
  const runtime = await startRuntime({
    onStart: () => Promise.resolve(),
    onDestroy: () => {
      destroyed = true
    },
  })
  open.push(runtime)
  const client = await connect(runtime)
  await client.waitFor(frame => frame.type === 'bridge-hello')
  client.send({ type: 'destroy' })
  await runtime.exited
  expect(destroyed).toBe(true)
  expect(client.frames.some((frame: Frame) => frame.type === 'bridge-stop')).toBe(false)
})

it('routes a known interrupt to the turn and refuses the rest on the sending socket', async () => {
  const turn = createFakeTurn()
  const runtime = await runtimeWith(turn)
  const client = await connect(runtime)
  await client.waitFor(frame => frame.type === 'bridge-hello')

  // No turn running yet: an error on this socket, never on the event stream.
  client.send({ type: 'interrupt', reason: 'watchdog' })
  const noTurn = await client.waitFor(frame => frame.type === 'error')
  expect(noTurn).toMatchObject({ phase: 'run', error: 'no running turn to interrupt' })
  expect(noTurn.seq).toBeUndefined()

  client.send({ type: 'start', prompt: 'go' })
  await turn.started
  await client.waitFor(frame => frame.type === 'bridge-started')

  client.send({ type: 'interrupt', reason: 'nonsense' })
  await client.waitFor(frame => frame.type === 'error' && frame !== noTurn
    && String(frame.error).startsWith('unknown interrupt reason'))
  expect(turn.interrupts).toEqual([])

  client.send({ type: 'interrupt', reason: 'budget' })
  await expect.poll(() => turn.interrupts).toEqual(['budget'])
})

/*
 * The runtime validates an inbound reason against its own hardcoded list (the frame is a cast,
 * not a parse) while `@amond-ai/harness-protocol` publishes the schema a client sends by. They
 * were one file until this package was extracted; now they are two, in packages with no runtime
 * dependency between them, and a drift is silent — the runtime would refuse a reason the schema
 * accepts, on the sending socket only, where nothing else looks.
 */
it('keeps its interrupt reasons equal to the published schema', () => {
  expect([...INTERRUPT_REASONS]).toEqual(interruptReasonSchema.options)
})
