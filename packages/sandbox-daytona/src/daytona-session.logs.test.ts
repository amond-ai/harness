import type { ProcessLogEvent } from '@amond-ai/sandbox'
import { describe, expect, it } from 'vitest'
import {
  endProcess,
  fakeSandbox,
  forgetSession,
  session,
  setLogs,
  streamOf,
} from './daytona-session.fixtures'

const decode = (data: Uint8Array): string => new TextDecoder().decode(data)

type StreamEvent = Extract<ProcessLogEvent, { type: 'stdout' | 'stderr' }>

function textOf(events: ProcessLogEvent[], type: 'stdout' | 'stderr'): string {
  return events
    .filter((event): event is StreamEvent => event.type === type)
    .map(event => decode(event.data))
    .join('')
}

async function collect(stream: ReadableStream<ProcessLogEvent>): Promise<ProcessLogEvent[]> {
  const events: ProcessLogEvent[] = []
  for await (const event of streamOf(stream)) {
    events.push(event)
  }
  return events
}

describe('logs(): the whole transcript', () => {
  /**
   * `replayTurn`'s read, and the one Daytona makes cheap: `getSessionCommandLogs` retains stdout
   * and stderr *separately* past the command's exit, so nothing has to be journalled for it.
   */
  it('replays both streams and how the turn ended', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    setLogs(fake, 'run-1', { stdout: '{"type":"result"}', stderr: 'warning' })
    endProcess(fake, 'run-1', 0)

    const events = await collect(await handle.logs())
    expect(textOf(events, 'stdout')).toBe('{"type":"result"}')
    expect(textOf(events, 'stderr')).toBe('warning')
    expect(events.at(-1)).toMatchObject({ type: 'terminal', state: 'exited', exit: { code: 0 } })
  })

  it('leaves a still-running turn unterminated', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    setLogs(fake, 'run-1', { stdout: 'partial' })

    const events = await collect(await handle.logs())
    expect(events.some(event => event.type === 'terminal')).toBe(false)
  })

  /**
   * `replayTurn` folds a turn into a bounded window so the full transcript never exists in
   * memory (AC-016); one event carrying a noisy turn's whole output defeats that back-pressure
   * even though the read itself has already paid for the string.
   */
  it('emits the transcript in chunks rather than as one event per stream', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    setLogs(fake, 'run-1', { stdout: 'x'.repeat(70_000) })

    const events = await collect(await handle.logs())
    expect(events.filter(event => event.type === 'stdout').length).toBeGreaterThan(1)
    expect(textOf(events, 'stdout').length).toBe(70_000)
  })

  it('stops waiting on a whole-transcript read when the caller aborts', async () => {
    // The same degraded daemon, reached by a replay rather than a watchdog sample (cubic review,
    // PR #66; #69): reading the stream must reject with the reason, not stay pending.
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    fake.sandbox.process.getSessionCommandLogs = async () => new Promise(() => {})
    const controller = new AbortController()

    const replay = collect(await handle.logs({ replay: true, signal: controller.signal }))
    setTimeout(() => controller.abort(new Error('caller left')), 5)

    await expect(replay).rejects.toThrow('caller left')
  })

  it('makes no daemon call for a replay whose caller has already aborted', async () => {
    // Both reads are requests to the toolbox daemon; an abort that already fired must not start
    // one only to abandon it (codex review, PR #82).
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    const before = { ...fake.calls }

    const replay = collect(await handle.logs({ replay: true, signal: AbortSignal.abort(new Error('caller left')) }))

    await expect(replay).rejects.toThrow('caller left')
    expect(fake.calls).toEqual(before)
  })

  it('serves no more of a loaded transcript once the caller aborts between chunks', async () => {
    // The log arrives whole, so the abort can only land while the stream is paused between 64 KiB
    // events — after every read has settled (codex and cubic review, PR #77).
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    setLogs(fake, 'run-1', { stdout: 'x'.repeat(70_000) })
    endProcess(fake, 'run-1', 0)
    const controller = new AbortController()

    const reader = (await handle.logs({ replay: true, signal: controller.signal })).getReader()
    expect((await reader.read()).value).toMatchObject({ type: 'stdout' })
    controller.abort(new Error('caller left'))

    // The stream may already hold the next chunk it prefetched; nothing after that is served.
    const served: string[] = []
    const drained = (async () => {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          return
        }
        served.push(value.type)
      }
    })()
    await expect(drained).rejects.toThrow('caller left')
    expect(served).not.toContain('terminal')
  })
})

describe('logs({ since }): the watchdog\'s sample', () => {
  it('serves what arrived since the cursor and nothing before it', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    setLogs(fake, 'run-1', { stdout: 'first' })

    const opening = await collect(await handle.logs())
    const cursor = opening.at(-1)?.cursor ?? ''
    setLogs(fake, 'run-1', { stdout: 'firstsecond' })

    const sample = await collect(await handle.logs({ since: cursor }))
    expect(textOf(sample, 'stdout')).toBe('second')
    expect(sample.some(event => event.type === 'terminal')).toBe(false)
  })

  it('serves nothing at all when the turn has not written since', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    setLogs(fake, 'run-1', { stdout: 'quiet' })

    const cursor = (await collect(await handle.logs())).at(-1)?.cursor ?? ''
    expect(await collect(await handle.logs({ since: cursor }))).toEqual([])
  })

  it('stops waiting on the read when the caller aborts', async () => {
    // `getSessionCommandLogs` takes no signal, so this one never settles: a watchdog that timed
    // out must still get its answer back rather than wait on a degraded daemon.
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    let reads = 0
    fake.sandbox.process.getSessionCommandLogs = async () => {
      reads++
      return new Promise(() => {})
    }
    const controller = new AbortController()

    const pending = handle.logs({ since: '0:0', signal: controller.signal })
    await Promise.resolve()
    controller.abort(new Error('watchdog'))

    await expect(pending).rejects.toThrow('watchdog')
    expect(reads).toBe(1)
  })
})

describe('logs({ follow: true }): the live read', () => {
  /**
   * `harness-sandbox` reads end-of-stream as "the bridge exited", so this may not close while the
   * process is alive — and must close once it is not.
   */
  it('stays open over a live command and ends on its exit', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    setLogs(fake, 'run-1', { stdout: 'ready' })

    const reader = (await handle.logs({ follow: true, replay: true })).getReader()
    const first = await reader.read()
    expect(decode((first.value as { data: Uint8Array }).data)).toBe('ready')

    setLogs(fake, 'run-1', { stdout: 'readydone' })
    endProcess(fake, 'run-1', 0)
    const rest: ProcessLogEvent[] = []
    for (;;) {
      const next = await reader.read()
      if (next.done) {
        break
      }
      rest.push(next.value)
    }
    expect(textOf(rest, 'stdout')).toBe('done')
    expect(rest.at(-1)).toMatchObject({ type: 'terminal', state: 'exited', exit: { code: 0 } })
  })

  /**
   * `replay` is the contract's own word for the difference — the retained log from the beginning,
   * or the live tail — so a follower that omitted it must not be served the transcript it
   * deliberately did not ask for.
   */
  it('starts at the live tail unless the caller asked for the replay', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    setLogs(fake, 'run-1', { stdout: 'already-here' })
    endProcess(fake, 'run-1', 0)

    expect(textOf(await collect(await handle.logs({ follow: true })), 'stdout')).toBe('')
    expect(textOf(await collect(await handle.logs({ follow: true, replay: true })), 'stdout'))
      .toBe('already-here')
  })

  /** Gone with nothing recorded is an ending too, and it is not silence. */
  it('ends on no_exit_record when the session vanishes under it', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    forgetSession(fake, 'run-1')

    expect((await collect(await handle.logs({ follow: true }))).at(-1))
      .toMatchObject({ type: 'terminal', state: 'error', error: { code: 'no_exit_record' } })
  })

  it('closes immediately for a caller whose signal has already fired', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake).exec(['claude'])
    setLogs(fake, 'run-1', { stdout: 'ignored' })

    expect(await collect(await handle.logs({ follow: true, replay: true, signal: AbortSignal.abort() })))
      .toEqual([])
  })

  /**
   * A `ReadableStream` keeps one `pull` in flight, so at cancel time the tail is usually inside
   * `next()` polling a process that may never exit, and a `return()` would queue behind it. The
   * abort has to land first or `cancel()` never settles.
   */
  it('settles a cancel against a command that is still running', async () => {
    const fake = fakeSandbox()
    const handle = await session(fake, ['run-1'], { followIntervalMs: 50 }).exec(['claude'])
    setLogs(fake, 'run-1', { stdout: 'live' })

    const reader = (await handle.logs({ follow: true, replay: true })).getReader()
    await reader.read()
    await expect(reader.cancel()).resolves.toBeUndefined()
  })

  /**
   * `getSessionCommandLogs` takes no signal, so a poll against a degraded daemon never settles on
   * its own. The stop signal has to reach the read itself, not only the sleep between polls, or
   * the follow outlives the caller that left it.
   */
  describe('while a poll hangs', () => {
    function hangingHandle() {
      const fake = fakeSandbox()
      fake.sandbox.process.getSessionCommandLogs = async () => new Promise(() => {})
      return session(fake).exec(['claude'])
    }

    it('closes the stream when the caller aborts', async () => {
      const handle = await hangingHandle()
      const controller = new AbortController()

      const finished = collect(await handle.logs({ follow: true, replay: true, signal: controller.signal }))
      await Promise.resolve()
      controller.abort(new Error('caller left'))

      await expect(finished).resolves.toEqual([])
    })

    it('settles a cancel', async () => {
      const handle = await hangingHandle()
      const reader = (await handle.logs({ follow: true, replay: true })).getReader()

      const pending = reader.read()
      await Promise.resolve()

      await expect(reader.cancel()).resolves.toBeUndefined()
      await expect(pending).resolves.toMatchObject({ done: true })
    })
  })
})
