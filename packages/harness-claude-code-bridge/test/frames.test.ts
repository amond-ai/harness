import type { Host } from './harness'
import { readFileSync } from 'node:fs'
import { afterEach, expect, it } from 'vitest'
import {
  connect,
  createFakeQuery,
  initMessage,
  resultMessage,
  startHost,
  streamEventMessages,
} from './harness'

let host: Host | undefined

afterEach(async () => {
  await host?.close()
  host = undefined
})

it('emits every non-stream_event SDK message as a journaled raw frame', async () => {
  const query = createFakeQuery([
    initMessage(),
    { type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } },
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const raws = client.frames.filter(frame => frame.type === 'raw')
  expect(raws.map(frame => (frame.rawValue as { type: string }).type)).toEqual([
    'system',
    'assistant',
    'result',
  ])
  expect(raws.every(frame => typeof frame.seq === 'number')).toBe(true)

  // The journal already held each raw frame when the socket received it.
  const journal = await host.readJournal()
  expect(journal.filter(frame => frame.type === 'raw')).toHaveLength(3)
})

it('acknowledges a start before the query has said anything', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  const types = client.frames.map(frame => frame.type)
  expect(types.indexOf('bridge-started')).toBeGreaterThan(types.indexOf('bridge-hello'))
  expect(types.indexOf('bridge-started')).toBeLessThan(types.indexOf('raw'))
  expect(client.frames.find(frame => frame.type === 'bridge-started')?.seq).toEqual(expect.any(Number))
  expect((await host.readJournal()).some(frame => frame.type === 'bridge-started')).toBe(true)
})

it('keeps stream_event-derived frames out of the journal and out of a replay', async () => {
  const query = createFakeQuery([
    initMessage(),
    ...streamEventMessages(),
    resultMessage(),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  await client.waitFor(frame => frame.type === 'finish')

  expect(client.frames.some(frame => frame.type === 'text-delta')).toBe(true)

  const journal = await host.readJournal()
  expect(journal.some(frame => frame.type === 'text-delta')).toBe(false)
  expect(journal.some(frame => frame.type === 'text-start')).toBe(false)

  const replayed = await connect(host)
  replayed.send({ type: 'resume', lastSeenEventId: 0 })
  await replayed.waitFor(frame => frame.type === 'finish')
  expect(replayed.frames.some(frame => frame.type === 'raw')).toBe(true)
  expect(replayed.frames.some(frame => frame.type === 'text-delta')).toBe(false)
  replayed.close()
  client.close()
})

it('reports the session transcript and journal paths on finish', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  const artifacts = finish.sessionArtifacts as {
    sessionId: string
    sessionTranscriptPath: string
    journalPath: string
  }
  expect(artifacts.sessionTranscriptPath).toMatch(
    /\/projects\/-workspace-repo\/sess-1\.jsonl$/,
  )
  // The id itself, not only the file named after it: a resuming client sends
  // it as `start.resume` rather than parsing it back out of the path.
  expect(artifacts.sessionId).toBe('sess-1')
  expect(artifacts.journalPath).toBe(host.journalPath)
  expect(finish.stopped).toBe('completed')
  client.close()
})

/*
 * A run-phase `error` is how a turn ordinarily fails, and `system`/`init` has
 * already named a session by then — so the client that retries the attempt is
 * told which session to resume, exactly as a `finish` would.
 */
it('reports the session artifacts on a run-phase error too', async () => {
  // A `result` the CLI did not call a success is the ordinary run-phase failure.
  const query = createFakeQuery([
    initMessage(),
    resultMessage({ subtype: 'error_during_execution', errors: ['the model went away'] }),
  ])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing' })
  const failure = await client.waitFor(frame => frame.type === 'error')

  expect(failure.phase).toBe('run')
  const artifacts = failure.sessionArtifacts as {
    sessionId: string
    sessionTranscriptPath: string
    journalPath: string
  }
  expect(artifacts.sessionId).toBe('sess-1')
  expect(artifacts.sessionTranscriptPath).toMatch(
    /\/projects\/-workspace-repo\/sess-1\.jsonl$/,
  )
  expect(artifacts.journalPath).toBe(host.journalPath)
  client.close()
})

/*
 * A `CLAUDE_CONFIG_DIR` on `start.env` moves the CLI's `projects/` tree, so the
 * reported transcript has to be resolved against the environment the child got
 * — not the host's own, which is what the bridge process was launched with.
 */
it('resolves the session transcript against the child environment', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({
    type: 'start',
    prompt: 'do the thing',
    env: { CLAUDE_CONFIG_DIR: '/tmp/alt-config' },
  })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  const artifacts = finish.sessionArtifacts as {
    sessionTranscriptPath: string
  }
  expect(artifacts.sessionTranscriptPath).toBe(
    '/tmp/alt-config/projects/-workspace-repo/sess-1.jsonl',
  )
  client.close()
})

/*
 * `persistSession: false` tells the SDK to write no session file at all, so a
 * reported path would name a transcript that does not exist. The journal is the
 * bridge's own file and is unaffected.
 */
it('reports no transcript path when the turn does not persist its session', async () => {
  const query = createFakeQuery([initMessage(), resultMessage()])
  host = await startHost({ query: query.fn })
  const client = await connect(host)

  client.send({ type: 'start', prompt: 'do the thing', persistSession: false })
  const finish = await client.waitFor(frame => frame.type === 'finish')

  const artifacts = finish.sessionArtifacts as {
    sessionTranscriptPath?: string
    journalPath: string
  }
  expect(artifacts.sessionTranscriptPath).toBeUndefined()
  expect(artifacts.journalPath).toBe(host.journalPath)
  client.close()
})

it('delivers each frame once when a resume lands mid-journal', async () => {
  // Enough frames that the awaited appends are still draining when the second
  // socket resumes: that window is the one where `replay` and the journal
  // chain can both reach for the same frame.
  const chatter = Array.from({ length: 400 }, (_, index) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text: `line ${index}` }] },
  }))
  const query = createFakeQuery([initMessage(), ...chatter, resultMessage()])
  host = await startHost({ query: query.fn })
  const first = await connect(host)
  const second = await connect(host)

  first.send({ type: 'start', prompt: 'do the thing' })
  // Resume once the first socket has seen a frame: the chain has then drained
  // one append and the rest of the turn is queued behind it, so `replay` reads
  // a log whose tail the chain is still holding.
  await first.waitFor(frame => frame.type === 'raw')
  second.send({ type: 'resume', lastSeenEventId: 0 })
  await second.waitFor(frame => frame.type === 'finish')
  // `finish` arrives on the replayed tail, so the frames the chain still holds
  // land after it. Stop the host and wait for the close it sends once the chain
  // has fully drained: only then is the delivery count final.
  second.send({ type: 'stop' })
  await second.closed

  const seqs = second.frames
    .map(frame => frame.seq)
    .filter((seq): seq is number => seq !== undefined)
  expect(new Set(seqs).size).toBe(seqs.length)
  // Every journaled frame reached the resumed socket, in order and with no gap.
  expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, index) => index + 1))

  first.close()
})

/**
 * The journal-before-send invariant has to hold on the resume path too. `replay`
 * used to read the in-memory log and write straight to the socket, so a frame
 * whose append was still queued could reach the host before it was on disk —
 * exactly the window the Worker's `turn_end` mirror reads across.
 */
it('journals every replayed frame before the resumed socket sees it', async () => {
  const chatter = Array.from({ length: 400 }, (_, index) => ({
    type: 'assistant',
    message: { content: [{ type: 'text', text: `line ${index}` }] },
  }))
  const query = createFakeQuery([initMessage(), ...chatter, resultMessage()])
  host = await startHost({ query: query.fn })
  const first = await connect(host)
  // Read the journal as each frame lands, not afterwards: by the end everything
  // is on disk and the race this covers would leave no trace.
  const unjournaled: number[] = []
  const second = await connect(host, (frame) => {
    if (frame.seq === undefined) {
      return
    }
    const journaled = readFileSync(host!.journalPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map(line => (JSON.parse(line) as { seq: number }).seq)
    if (!journaled.includes(frame.seq)) {
      unjournaled.push(frame.seq)
    }
  })

  first.send({ type: 'start', prompt: 'do the thing' })
  await first.waitFor(frame => frame.type === 'raw')
  second.send({ type: 'resume', lastSeenEventId: 0 })
  await second.waitFor(frame => frame.type === 'finish')
  second.send({ type: 'stop' })
  await second.closed

  expect(unjournaled).toEqual([])
  first.close()
})
